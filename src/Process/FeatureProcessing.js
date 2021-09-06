import * as THREE from 'three';
import LayerUpdateState from 'Layer/LayerUpdateState';
import ObjectRemovalHelper from 'Process/ObjectRemovalHelper';
import handlingError from 'Process/handlerNodeError';
import Coordinates from 'Core/Geographic/Coordinates';
import Crs from 'Core/Geographic/Crs';

const coord = new Coordinates('EPSG:4326', 0, 0, 0);
const dim_ref = new THREE.Vector2();
const dim = new THREE.Vector2();
const scale = new THREE.Vector2();

function assignLayer(object, layer) {
    if (object) {
        object.layer = layer;
        if (object.material) {
            object.material.transparent = layer.opacity < 1.0;
            object.material.opacity = layer.opacity;
            object.material.wireframe = layer.wireframe;
        }
        object.layers.set(layer.threejsLayer);
        for (const c of object.children) {
            assignLayer(c, layer);
        }
        return object;
    }
}

class FeatureNode extends THREE.Group {
    constructor(mesh) {
        super();
        this.transformToLocal = new THREE.Group();
        this.place = new THREE.Group();
        this.mesh = mesh;
        // mesh.add(new THREE.AxesHelper(2000));
    }

    as(crs) {
        const mesh = this.mesh;
        // scale original extent to re-projected extent
        const extent =  mesh.feature.extent.as(Crs.formatToEPSG(mesh.feature.extent.crs));
        extent.dimensions(dim_ref, crs);
        extent.dimensions(dim);
        scale.copy(dim_ref).divide(dim);

        this.transformToLocal.scale.set(scale.x, scale.y, 1);

        // rotate data if data is inverted
        if (mesh.layer.source.isInverted) {
            this.transformToLocal.rotateZ(0.5 * Math.PI);
        }

        // position
        this.place.position.copy(mesh.position).negate();
        this.add(this.transformToLocal.add(this.place.add(mesh)));

        coord.setFromVector3(mesh.position);
        coord.crs = Crs.formatToEPSG(mesh.feature.extent.crs);
        coord.as(crs, coord).toVector3(this.position);

        return this;
    }
}

export default {
    update(context, layer, node) {
        if (!node.parent && node.children.length) {
            // if node has been removed dispose three.js resource
            ObjectRemovalHelper.removeChildrenAndCleanupRecursively(layer, node);
            return;
        }
        if (!node.visible) {
            return;
        }

        if (node.layerUpdateState[layer.id] === undefined) {
            node.layerUpdateState[layer.id] = new LayerUpdateState();
        } else if (!node.layerUpdateState[layer.id].canTryUpdate()) {
            return;
        }

        const features = node.children.filter(n => n.layer && (n.layer.id == layer.id));

        if (features.length > 0) {
            return features;
        }

        // 'TMS:4326', zoom: 14, row: 3749, col: 16609
        // 'TMS:4326', zoom: 14, row: 3750, col: 16609
        //

        const extent = node.getExtentsByProjection('TMS:4326')[0];

        if (!(extent.col == 16609  && (extent.row == 3749 || extent.row == 3750))) {
            node.layerUpdateState[layer.id].noMoreUpdatePossible();
            return;
        }
        console.log('extent.row', extent.row);

        const extentsDestination = node.getExtentsByProjection(layer.source.crs) || [node.extent];

        const zoomDest = extentsDestination[0].zoom;

        // check if it's tile level is equal to display level layer.
        if (zoomDest != layer.zoom.min ||
        // check if there's data in extent tile.
            !this.source.extentInsideLimit(node.extent, zoomDest) ||
        // In FileSource case, check if the feature center is in extent tile.
            (layer.source.isFileSource && !node.extent.isPointInside(layer.source.extent.center(coord)))) {
        // if not, there's not data to add at this tile.
            node.layerUpdateState[layer.id].noMoreUpdatePossible();
            return;
        }

        node.layerUpdateState[layer.id].newTry();

        const command = {
            layer,
            extentsSource: extentsDestination,
            view: context.view,
            threejsLayer: layer.threejsLayer,
            requester: node,
        };

        return context.scheduler.execute(command).then((meshes) => {
            // if request return empty json, WFSProvider.getFeatures return undefined

            // remove old group layer
            node.remove(...node.children.filter(c => c.layer && c.layer.id == layer.id));

            node.layerUpdateState[layer.id].success();

            meshes.forEach((mesh) => {
                assignLayer(mesh, layer);
                // call onMeshCreated callback if needed
                if (layer.onMeshCreated) {
                    layer.onMeshCreated(mesh);
                }

                if (!node.parent) {
                    ObjectRemovalHelper.removeChildrenAndCleanupRecursively(layer, mesh);
                    // return;
                } else if (!mesh.parent || !mesh.parent.visible) {
                    const featureNode = new FeatureNode(mesh).as(context.view.referenceCrs);
                    node.worldToLocal(featureNode.position);
                    featureNode.layer = layer;
                    node.add(featureNode);
                }
            });
            node.updateMatrixWorld();
        },
        err => handlingError(err, node, layer, node.level, context.view));
    },
};
