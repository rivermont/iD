import _extend from 'lodash-es/extend';
import _find from 'lodash-es/find';
import _forEach from 'lodash-es/forEach';

import rbush from 'rbush';

import { dispatch as d3_dispatch } from 'd3-dispatch';
import { json as d3_json } from 'd3-request';
import { request as d3_request } from 'd3-request';

import { geoExtent, geoVecAdd } from '../geo';
import { krError } from '../osm';
import { t } from '../util/locale';
import { utilRebind, utilTiler, utilQsString } from '../util';

import { errorTypes } from '../../data/keepRight.json';


var tiler = utilTiler();
var dispatch = d3_dispatch('loaded');

var _krCache;
var _krZoom = 14;
var _krUrlRoot = 'https://www.keepright.at/';
var _krLocalize = {
    node: 'node',
    way: 'way',
    relation: 'relation',
    highway: 'highway',
    railway: 'railway',
    waterway: 'waterway',
    cycleway: 'cycleway',
    footpath: 'footpath',
    'cycleway/footpath': 'cycleway_footpath',
    riverbank: 'riverbank',
    bridge: 'bridge',
    tunnel: 'tunnel',
    place_of_worship: 'place_of_worship',
    pub: 'pub',
    restaurant: 'restaurant',
    school: 'school',
    university: 'university',
    hospital: 'hospital',
    library: 'library',
    theatre: 'theatre',
    courthouse: 'courthouse',
    bank: 'bank',
    cinema: 'cinema',
    pharmacy: 'pharmacy',
    cafe: 'cafe',
    fast_food: 'fast_food',
    fuel: 'fuel',
    from: 'from',
    to: 'to'
};

var _krRuleset = [
    // no 20 - multiple node on same spot - these are mostly boundaries overlapping roads
    30, 40, 50, 60, 70, 90, 100, 110, 120, 130, 150, 160, 170, 180,
    190, 191, 192, 193, 194, 195, 196, 197, 198,
    200, 201, 202, 203, 204, 205, 206, 207, 208, 210, 220,
    230, 231, 232, 270, 280, 281, 282, 283, 284, 285,
    290, 291, 292, 293, 294, 295, 296, 297, 298, 300, 310, 311, 312, 313,
    320, 350, 360, 370, 380, 390, 400, 401, 402, 410, 411, 412, 413
];


function abortRequest(i) {
    if (i) {
        i.abort();
    }
}

function abortUnwantedRequests(cache, tiles) {
    _forEach(cache.inflight, function(v, k) {
        var wanted = _find(tiles, function(tile) {
            return k === tile.id;
        });
        if (!wanted) {
            abortRequest(v);
            delete cache.inflight[k];
        }
    });
}


function encodeErrorRtree(d) {
    return { minX: d.loc[0], minY: d.loc[1], maxX: d.loc[0], maxY: d.loc[1], data: d };
}


// replace or remove error from rtree
function updateRtree(item, replace) {
    _krCache.rtree.remove(item, function isEql(a, b) {
        return a.data.id === b.data.id;
    });

    if (replace) {
        _krCache.rtree.insert(item);
    }
}


function tokenReplacements(d) {
    if (!(d instanceof krError)) return;

    var htmlRegex = new RegExp(/<\/[a-z][\s\S]*>/);
    var replacements = {};

    var errorTemplate = errorTypes[d.which_type];
    if (!errorTemplate) {
        /* eslint-disable no-console */
        console.log('No Template: ', d.which_type);
        console.log('  ', d.description);
        /* eslint-enable no-console */
        return;
    }

    // some descriptions are just fixed text
    if (!errorTemplate.regex) return;

    // regex pattern should match description with variable details captured as groups
    var errorRegex = new RegExp(errorTemplate.regex, 'i');
    var errorMatch = errorRegex.exec(d.description);
    if (!errorMatch) {
        /* eslint-disable no-console */
        console.log('Unmatched: ', d.which_type);
        console.log('  ', d.description);
        console.log('  ', errorRegex);
        /* eslint-enable no-console */
        return;
    }

    for (var i = 1; i < errorMatch.length; i++) {   // skip first
        var group = errorMatch[i];
        var idType;

        idType = 'IDs' in errorTemplate ? errorTemplate.IDs[i-1] : '';
        if (idType && group) {   // link IDs if present in the group
            group = parseError(group, idType);
        } else if (htmlRegex.test(group)) {   // escape any html in non-IDs
            group = '\\' +  group + '\\';
        } else if (_krLocalize[group]) {   // some replacement strings can be localized
            group = t('QA.keepRight.error_parts.' + _krLocalize[group]);
        }

        replacements['var' + i] = group;
    }

    return replacements;
}


function parseError(group, idType) {

    function linkEntity(d) {
        return '<span><a class="kr_error_description-id">' + d + '</a></span>';
    }

    // arbitrary node list of form: #ID, #ID, #ID...
    function parseError211(capture) {
        var newList = [];
        var items = capture.split(', ');

        items.forEach(function(item) {
            // ID has # at the front
            var id = linkEntity('n' + item.slice(1));
            newList.push(id);
        });

        return newList.join(', ');
    }

    // arbitrary way list of form: #ID(layer),#ID(layer),#ID(layer)...
    function parseError231(capture) {
        var newList = [];
        // unfortunately 'layer' can itself contain commas, so we split on '),'
        var items = capture.split('),');

        items.forEach(function(item) {
            var match = item.match(/\#(\d+)\((.+)\)?/);
            if (match !== null && match.length > 2) {
                newList.push(linkEntity('w' + match[1]) + ' ' +
                    t('QA.keepRight.errorTypes.231.layer', { layer: match[2] })
                );
            }
        });

        return newList.join(', ');
    }

    // arbitrary node/relation list of form: from node #ID,to relation #ID,to node #ID...
    function parseError294(capture) {
        var newList = [];
        var items = capture.split(',');

        items.forEach(function(item) {
            var role;
            var idType;
            var id;

            // item of form "from/to node/relation #ID"
            item = item.split(' ');

            // to/from role is more clear in quotes
            role = '"' + item[0] + '"';

            // first letter of node/relation provides the type
            idType = item[1].slice(0,1);

            // ID has # at the front
            id = item[2].slice(1);
            id = linkEntity(idType + id);

            item = [role, item[1], id].join(' ');
            newList.push(item);
        });

        return newList.join(', ');
    }

    // may or may not include the string "(including the name 'name')"
    function parseError370(capture) {
        if (!capture) return '';

        var match = capture.match(/\(including the name (\'.+\')\)/);
        if (match !== null && match.length) {
            return t('QA.keepRight.errorTypes.370.including_the_name', { name: match[1] });
        }
        return '';
    }

    // arbitrary node list of form: #ID,#ID,#ID...
    function parseWarning20(capture) {
        var newList = [];
        var items = capture.split(',');

        items.forEach(function(item) {
            // ID has # at the front
            var id = linkEntity('n' + item.slice(1));
            newList.push(id);
        });

        return newList.join(', ');
    }

    switch (idType) {
        // simple case just needs a linking span
        case 'n':
        case 'w':
        case 'r':
            group = linkEntity(idType + group);
            break;
        // some errors have more complex ID lists/variance
        case '211':
            group = parseError211(group);
            break;
        case '231':
            group = parseError231(group);
            break;
        case '294':
            group = parseError294(group);
            break;
        case '370':
            group = parseError370(group);
            break;
        case '20':
            group = parseWarning20(group);
    }

    return group;
}


export default {
    init: function() {
        if (!_krCache) {
            this.reset();
        }

        this.event = utilRebind(this, dispatch, 'on');
    },

    reset: function() {
        if (_krCache) {
            _forEach(_krCache.inflight, abortRequest);
        }
        _krCache = { loaded: {}, inflight: {}, keepRight: {}, rtree: rbush() };
    },


    // KeepRight API:  http://osm.mueschelsoft.de/keepright/interfacing.php
    loadErrors: function(projection) {
        var options = { format: 'geojson' };
        var rules = _krRuleset.join();

        // determine the needed tiles to cover the view
        var tiles = tiler
            .zoomExtent([_krZoom, _krZoom])
            .getTiles(projection);

        // abort inflight requests that are no longer needed
        abortUnwantedRequests(_krCache, tiles);

        // issue new requests..
        tiles.forEach(function(tile) {
            if (_krCache.loaded[tile.id] || _krCache.inflight[tile.id]) return;

            var rect = tile.extent.rectangle();
            var params = _extend({}, options, { left: rect[0], bottom: rect[3], right: rect[2], top: rect[1] });
            var url = _krUrlRoot + 'export.php?' + utilQsString(params) + '&ch=' + rules;

            _krCache.inflight[tile.id] = d3_json(url,
                function(err, data) {
                    delete _krCache.inflight[tile.id];

                    if (err) return;
                    _krCache.loaded[tile.id] = true;

                    if (!data.features || !data.features.length) return;

                    data.features.forEach(function(feature) {
                        var loc = feature.geometry.coordinates;
                        var props = feature.properties;

                        // if there is a parent, save its error type e.g.:
                        //  Error 191 = "highway-highway"
                        //  Error 190 = "intersections without junctions"  (parent)
                        var errorType = props.error_type;
                        var errorTemplate = errorTypes[errorType];
                        var parentErrorType = (Math.floor(errorType / 10) * 10).toString();

                        // try to handle error type directly, fallback to parent error type.
                        var whichType = errorTemplate ? errorType : parentErrorType;

                        // - move markers slightly so it doesn't obscure the geometry,
                        // - then move markers away from other coincident markers
                        var coincident = false;
                        do {
                            // first time, move marker up. after that, move marker right.
                            var delta = coincident ? [0.00002, 0] : [0, 0.00002];
                            loc = geoVecAdd(loc, delta);
                            var bbox = geoExtent(loc).bbox();
                            coincident = _krCache.rtree.search(bbox).length;
                        } while (coincident);

                        var d = new krError({
                            loc: loc,
                            id: props.error_id,
                            comment: props.comment || null,
                            description: props.description || '',
                            error_id: props.error_id,
                            which_type: whichType,
                            error_type: errorType,
                            parent_error_type: parentErrorType,
                            object_id: props.object_id,
                            object_type: props.object_type,
                            schema: props.schema,
                            title: props.title
                        });

                        d.replacements = tokenReplacements(d);

                        _krCache.keepRight[d.id] = d;
                        _krCache.rtree.insert(encodeErrorRtree(d));
                    });

                    dispatch.call('loaded');
                }
            );
        });
    },


    postKeepRightUpdate: function(d, callback) {
        if (_krCache.inflight[d.id]) {
            return callback({ message: 'Error update already inflight', status: -2 }, d);
        }

        var that = this;
        var params = { schema: d.schema, id: d.error_id };

        if (d.state) {
            params.st = d.state;
        }
        if (d.newComment !== undefined) {
            params.co = d.newComment;
        }

        // NOTE: This throws a CORS err, but it seems successful.
        // We don't care too much about the response, so this is fine.
        var url = _krUrlRoot + 'comment.php?' + utilQsString(params);
        _krCache.inflight[d.id] = d3_request(url)
            .post(function(err) {
                delete _krCache.inflight[d.id];
                if (d.state === 'ignore' || d.state === 'ignore_t') {
                    that.removeError(d);
                } else {
                    d = that.replaceError(d.update({
                        comment: d.newComment,
                        newComment: undefined,
                        state: undefined
                    }));
                }

                return callback(err, d);
            });

    },


    // get all cached errors covering the viewport
    getErrors: function(projection) {
        var viewport = projection.clipExtent();
        var min = [viewport[0][0], viewport[1][1]];
        var max = [viewport[1][0], viewport[0][1]];
        var bbox = geoExtent(projection.invert(min), projection.invert(max)).bbox();

        return _krCache.rtree.search(bbox).map(function(d) {
            return d.data;
        });
    },


    // get a single error from the cache
    getError: function(id) {
        return _krCache.keepRight[id];
    },


    // replace a single error in the cache
    replaceError: function(error) {
        if (!(error instanceof krError) || !error.id) return;

        _krCache.keepRight[error.id] = error;
        updateRtree(encodeErrorRtree(error), true); // true = replace
        return error;
    },


    // remove a single error from the cache
    removeError: function(error) {
        if (!(error instanceof krError) || !error.id) return;

        delete _krCache.keepRight[error.id];
        updateRtree(encodeErrorRtree(error), false); // false = remove
    },


    errorURL: function(error) {
        return _krUrlRoot + 'report_map.php?schema=' + error.schema + '&error=' + error.id;
    }

};
