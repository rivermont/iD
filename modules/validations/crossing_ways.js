import _clone from 'lodash-es/clone';
import _map from 'lodash-es/map';
import _flattenDeep from 'lodash-es/flatten';

import { actionAddMidpoint, actionMergeNodes } from '../actions';
import { geoExtent, geoLineIntersection, geoSphericalClosestNode } from '../geo';
import { osmNode } from '../osm';
import { t } from '../util/locale';
import { utilDisplayLabel } from '../util';
import { validationIssue, validationIssueFix } from '../core/validator';


export function validationCrossingWays() {
    var type = 'crossing_ways';


    // Check if the edge going from n1 to n2 crosses (without a connection node)
    // any edge on way. Return the cross point if so.
    function findEdgeToWayCrossCoords(n1, n2, way, graph, oneOnly) {
        var crossCoords = [];
        var nA, nB;
        var segment1 = [n1.loc, n2.loc];
        var segment2;

        var nodes = graph.childNodes(way);
        for (var j = 0; j < nodes.length - 1; j++) {
            nA = nodes[j];
            nB = nodes[j + 1];
            if (nA.id === n1.id || nA.id === n2.id ||
                nB.id === n1.id || nB.id === n2.id) {
                // n1 or n2 is a connection node; skip
                continue;
            }
            segment2 = [nA.loc, nB.loc];
            var point = geoLineIntersection(segment1, segment2);
            if (point) {
                crossCoords.push({ edge: [nA.id, nB.id], point: point });
                if (oneOnly) {
                    break;
                }
            }
        }
        return crossCoords;
    }


    // returns the way or its parent relation, whichever has a useful feature type
    function getFeatureWithFeatureTypeTagsForWay(way, graph) {
        if (getFeatureTypeForTags(way.tags) === null) {
            // if the way doesn't match a feature type, check is parent relations
            var parentRels = graph.parentRelations(way);
            for (var i = 0; i < parentRels.length; i++) {
                var rel = parentRels[i];
                if (getFeatureTypeForTags(rel.tags) !== null) {
                    return rel;
                }
            }
        }
        return way;
    }


    function hasTag(tags, key) {
        return tags[key] !== undefined && tags[key] !== 'no';
    }

    function tagsImplyIndoors(tags) {
        return hasTag(tags, 'level') || tags.highway === 'corridor';
    }

    function allowsStructures(featureType) {
        return allowsBridge(featureType) || allowsTunnel(featureType);
    }
    function allowsBridge(featureType) {
        return featureType === 'highway' || featureType === 'railway';
    }
    function allowsTunnel(featureType) {
        return featureType === 'highway' || featureType === 'railway' || featureType === 'waterway';
    }
    function canCover(featureType) {
        return featureType === 'building';
    }


    function getFeatureTypeForCrossingCheck(way, graph) {
        var tags = getFeatureWithFeatureTypeTagsForWay(way, graph).tags;
        return getFeatureTypeForTags(tags);
    }


    // only validate certain waterway features
    var waterways = ['canal', 'ditch', 'drain', 'river', 'stream'];
    // ignore certain highway and railway features
    var ignoredHighways = ['rest_area', 'services'];
    var ignoredRailways = ['train_wash'];


    function getFeatureTypeForTags(tags) {
        if (hasTag(tags, 'building')) return 'building';

        // don't check non-building areas
        if (hasTag(tags, 'area')) return null;

        if (hasTag(tags, 'highway') && ignoredHighways.indexOf(tags.highway) === -1) return 'highway';
        if (hasTag(tags, 'railway') && ignoredRailways.indexOf(tags.railway) === -1) return 'railway';
        if (hasTag(tags, 'waterway') && waterways.indexOf(tags.waterway) !== -1) return 'waterway';

        return null;
    }


    function extendTagsByInferredLayer(tags, way) {
        if (!hasTag(tags, 'layer')) {
            tags.layer = way.layer().toString();
        }
        return tags;
    }


    function isLegitCrossing(way1, featureType1, way2, featureType2, graph) {
        var tags1 = _clone(getFeatureWithFeatureTypeTagsForWay(way1, graph).tags);
        var tags2 = _clone(getFeatureWithFeatureTypeTagsForWay(way2, graph).tags);
        tags1 = extendTagsByInferredLayer(tags1, way1);
        tags2 = extendTagsByInferredLayer(tags2, way2);

        if (tagsImplyIndoors(tags1) && tagsImplyIndoors(tags2) && tags1.level !== tags2.level) {
            // assume features don't interact if they're indoor on different levels
            return true;
        }

        if (allowsBridge(featureType1) && allowsBridge(featureType2)) {
            if (hasTag(tags1, 'bridge') && !hasTag(tags2, 'bridge')) return true;
            if (!hasTag(tags1, 'bridge') && hasTag(tags2, 'bridge')) return true;
            // crossing bridges must use different layers
            if (hasTag(tags1, 'bridge') && hasTag(tags2, 'bridge') && tags1.layer !== tags2.layer) return true;
        } else if (allowsBridge(featureType1) && hasTag(tags1, 'bridge')) return true;
        else if (allowsBridge(featureType2) && hasTag(tags2, 'bridge')) return true;

        if (allowsTunnel(featureType1) && allowsTunnel(featureType2)) {
            if (hasTag(tags1, 'tunnel') && !hasTag(tags2, 'tunnel')) return true;
            if (!hasTag(tags1, 'tunnel') && hasTag(tags2, 'tunnel')) return true;
            // crossing tunnels must use different layers
            if (hasTag(tags1, 'tunnel') && hasTag(tags2, 'tunnel') && tags1.layer !== tags2.layer) return true;
        } else if (allowsTunnel(featureType1) && hasTag(tags1, 'tunnel')) return true;
        else if (allowsTunnel(featureType2) && hasTag(tags2, 'tunnel')) return true;

        if (canCover(featureType1) && canCover(featureType2)) {
            // crossing covered features that can themselves cover must use different layers
            if (hasTag(tags1, 'covered') && hasTag(tags2, 'covered') && tags1.layer !== tags2.layer) return true;
        } else if (canCover(featureType1) && hasTag(tags2, 'covered')) return true;
        else if (canCover(featureType2) && hasTag(tags1, 'covered')) return true;

        if (!allowsStructures(featureType1) && !allowsStructures(featureType2)) {
            // if no structures are applicable, the layers must be different
            if (tags1.layer !== tags2.layer) return true;
        }
        return false;
    }


    // highway values for which we shouldn't recommend connecting to waterways
    var highwaysDisallowingFords = [
        'motorway', 'motorway_link', 'trunk', 'trunk_link',
        'primary', 'primary_link', 'secondary', 'secondary_link'
    ];
    var pathHighways = [
        'path', 'footway', 'cycleway', 'bridleway', 'pedestrian', 'steps', 'corridor'
    ];

    function tagsForConnectionNodeIfAllowed(entity1, entity2) {
        var featureType1 = getFeatureTypeForTags(entity1.tags);
        var featureType2 = getFeatureTypeForTags(entity2.tags);
        if (featureType1 === featureType2) {
            if (featureType1 === 'highway') {
                var entity1IsPath = pathHighways.indexOf(entity1.tags.highway) !== -1;
                var entity2IsPath = pathHighways.indexOf(entity2.tags.highway) !== -1;
                if ((entity1IsPath || entity2IsPath) && entity1IsPath !== entity2IsPath) {
                    // one feature is a path but not both, use a crossing

                    var pathFeature = entity1IsPath ? entity1 : entity2;
                    if (pathFeature.tags.highway === 'footway' &&
                        pathFeature.tags.footway === 'crossing' &&
                        ['marked', 'unmarked'].indexOf(pathFeature.tags.crossing) !== -1) {
                        // if the path is a crossing, match the crossing type
                        return { highway: 'crossing', crossing: pathFeature.tags.crossing };
                    }
                    return { highway: 'crossing' };
                }
                return {};
            }
            if (featureType1 === 'waterway') return {};
            if (featureType1 === 'railway') return {};

        } else {
            var featureTypes = [featureType1, featureType2];
            if (featureTypes.indexOf('highway') !== -1) {
                if (featureTypes.indexOf('railway') !== -1) {
                    if (pathHighways.indexOf(entity1.tags.highway) !== -1 ||
                        pathHighways.indexOf(entity2.tags.highway) !== -1) {
                        // path-rail connections use this tag
                        return { railway: 'crossing' };
                    } else {
                        // road-rail connections use this tag
                        return { railway: 'level_crossing' };
                    }
                }

                if (featureTypes.indexOf('waterway') !== -1) {
                    // do not allow fords on structures
                    if (hasTag(entity1.tags, 'tunnel') && hasTag(entity2.tags, 'tunnel')) return null;
                    if (hasTag(entity1.tags, 'bridge') && hasTag(entity2.tags, 'bridge')) return null;

                    if (highwaysDisallowingFords.indexOf(entity1.tags.highway) !== -1 ||
                        highwaysDisallowingFords.indexOf(entity2.tags.highway) !== -1) {
                        // do not allow fords on major highways
                        return null;
                    }
                    return { ford: 'yes' };
                }
            }
        }
        return null;
    }


    function findCrossingsByWay(primaryWay, graph, tree) {
        var edgeCrossInfos = [];
        if (primaryWay.type !== 'way') return edgeCrossInfos;

        var primaryFeatureType = getFeatureTypeForCrossingCheck(primaryWay, graph);
        if (primaryFeatureType === null) return edgeCrossInfos;

        var checkedSingleCrossingWays = {};

        for (var i = 0; i < primaryWay.nodes.length - 1; i++) {
            var nid1 = primaryWay.nodes[i];
            var nid2 = primaryWay.nodes[i + 1];
            var n1 = graph.entity(nid1);
            var n2 = graph.entity(nid2);
            var extent = geoExtent([
                [
                    Math.min(n1.loc[0], n2.loc[0]),
                    Math.min(n1.loc[1], n2.loc[1])
                ],
                [
                    Math.max(n1.loc[0], n2.loc[0]),
                    Math.max(n1.loc[1], n2.loc[1])
                ]
            ]);

            var intersected = tree.intersects(extent, graph);
            for (var j = 0; j < intersected.length; j++) {
                var way = intersected[j];

                if (way.type !== 'way') continue;

                // skip if this way was already checked and only one issue is needed
                if (checkedSingleCrossingWays[way.id]) continue;

                // don't check for self-intersection in this validation
                if (way.id === primaryWay.id) continue;

                // only check crossing highway, waterway, building, and railway
                var wayFeatureType = getFeatureTypeForCrossingCheck(way, graph);
                if (wayFeatureType === null ||
                    isLegitCrossing(primaryWay, primaryFeatureType, way, wayFeatureType, graph) ||
                    isLegitCrossing(way, wayFeatureType, primaryWay, primaryFeatureType, graph)) {
                    continue;
                }

                // create only one issue for building crossings
                var oneOnly = primaryFeatureType === 'building' || wayFeatureType === 'building';

                var crossCoords = findEdgeToWayCrossCoords(n1, n2, way, graph, oneOnly);
                for (var k = 0; k < crossCoords.length; k++) {
                    var crossingInfo = crossCoords[k];
                    edgeCrossInfos.push({
                        ways: [primaryWay, way],
                        featureTypes: [primaryFeatureType, wayFeatureType],
                        edges: [[n1.id, n2.id], crossingInfo.edge],
                        crossPoint: crossingInfo.point
                    });
                    if (oneOnly) {
                        checkedSingleCrossingWays[way.id] = true;
                    }
                }
            }
        }
        return edgeCrossInfos;
    }


    var validation = function(entity, context) {
        var graph = context.graph();
        var tree = context.history().tree();

        var waysToCheck = _flattenDeep(_map([entity], function(entity) {
            if (!getFeatureTypeForTags(entity.tags)) {
                return [];
            }
            if (entity.type === 'way') {
                return entity;
            } else if (entity.type === 'relation' &&
                entity.tags.type === 'multipolygon' &&
                // only check multipolygons if they are buildings
                hasTag(entity.tags, 'building')) {
                return _map(entity.members, function(member) {
                    if (context.hasEntity(member.id)) {
                        var entity = context.entity(member.id);
                        if (entity.type === 'way') {
                            return entity;
                        }
                    }
                    return [];
                });
            }
            return [];
        }));

        var crossings = waysToCheck.reduce(function(array, way) {
            return array.concat(findCrossingsByWay(way, graph, tree));
        }, []);

        var issues = [];
        crossings.forEach(function(crossing) {
            issues.push(createIssue(crossing, context));
        });
        return issues;
    };


    function createIssue(crossing, context) {
        var graph = context.graph();

        // use the entities with the tags that define the feature type
        var entities = crossing.ways.sort(function(entity1, entity2) {
            var type1 = getFeatureTypeForCrossingCheck(entity1, graph);
            var type2 = getFeatureTypeForCrossingCheck(entity2, graph);
            if (type1 === type2) {
                return utilDisplayLabel(entity1, context) > utilDisplayLabel(entity2, context);
            } else if (type1 === 'waterway') {
                return true;
            } else if (type2 === 'waterway') {
                return false;
            }
            return type1 < type2;
        });
        entities = _map(entities, function(way) {
            return getFeatureWithFeatureTypeTagsForWay(way, graph);
        });

        var connectionTags = tagsForConnectionNodeIfAllowed(entities[0], entities[1]);

        var featureType1 = crossing.featureTypes[0];
        var featureType2 = crossing.featureTypes[1];

        var isCrossingIndoors = tagsImplyIndoors(entities[0].tags) && tagsImplyIndoors(entities[1].tags);
        var isCrossingTunnels = allowsTunnel(featureType1) && hasTag(entities[0].tags, 'tunnel') &&
                                allowsTunnel(featureType2) && hasTag(entities[1].tags, 'tunnel');
        var isCrossingBridges = allowsBridge(featureType1) && hasTag(entities[0].tags, 'bridge') &&
                                allowsBridge(featureType2) && hasTag(entities[1].tags, 'bridge');

        var crossingTypeID;

        if (isCrossingIndoors) {
            crossingTypeID = 'indoor-indoor';
        } else if (isCrossingTunnels) {
            crossingTypeID = 'tunnel-tunnel';
        } else if (isCrossingBridges) {
            crossingTypeID = 'bridge-bridge';
        } else {
            crossingTypeID = crossing.featureTypes.sort().join('-');
        }
        if (connectionTags && (isCrossingIndoors || isCrossingTunnels || isCrossingBridges)) {
            crossingTypeID += '_connectable';
        }

        var messageDict = {
            feature: utilDisplayLabel(entities[0], context),
            feature2: utilDisplayLabel(entities[1], context)
        };

        var fixes = [];
        if (connectionTags) {
            fixes.push(new validationIssueFix({
                title: t('issues.fix.connect_features.title'),
                onClick: function() {
                    var loc = this.issue.loc;
                    var connectionTags = this.issue.info.connectionTags;
                    var edges = this.issue.info.edges;

                    context.perform(
                        function actionConnectCrossingWays(graph) {
                            // create the new node for the points
                            var node = osmNode({ loc: loc, tags: connectionTags });
                            graph = graph.replace(node);

                            var nodesToMerge = [node.id];
                            var mergeThresholdInMeters = 0.75;

                            edges.forEach(function(edge) {
                                var edgeNodes = [graph.entity(edge[0]), graph.entity(edge[1])];
                                var closestNodeInfo = geoSphericalClosestNode(edgeNodes, loc);
                                // if there is already a point nearby, use that
                                if (closestNodeInfo.distance < mergeThresholdInMeters) {
                                    nodesToMerge.push(closestNodeInfo.node.id);
                                // else add the new node to the way
                                } else {
                                    graph = actionAddMidpoint({loc: loc, edge: edge}, node)(graph);
                                }
                            });

                            if (nodesToMerge.length > 1) {
                                // if we're using nearby nodes, merge them with the new node
                                graph = actionMergeNodes(nodesToMerge, loc)(graph);
                            }

                            return graph;
                        },
                        t('issues.fix.connect_crossing_features.annotation')
                    );
                }
            }));
        }
        var useFixID;
        if (isCrossingIndoors) {
            useFixID = 'use_different_levels';
        } else if (isCrossingTunnels || isCrossingBridges) {
            useFixID = 'use_different_layers';
        } else if (allowsBridge(featureType1) || allowsBridge(featureType2)) {
            useFixID = 'use_bridge_or_tunnel';
        } else if (allowsTunnel(featureType1) || allowsTunnel(featureType2)) {
            useFixID = 'use_tunnel';
        } else {
            useFixID = 'use_different_layers';
        }
        fixes.push(new validationIssueFix({
            title: t('issues.fix.' + useFixID + '.title')
        }));
        fixes.push(new validationIssueFix({
            title: t('issues.fix.reposition_features.title')
        }));
        return new validationIssue({
            type: type,
            severity: 'warning',
            message: t('issues.crossing_ways.message', messageDict),
            tooltip: t('issues.crossing_ways.'+crossingTypeID+'.tip'),
            entities: entities,
            info: { edges: crossing.edges, connectionTags: connectionTags },
            loc: crossing.crossPoint,
            fixes: fixes
        });
    }

    validation.type = type;


    return validation;
}