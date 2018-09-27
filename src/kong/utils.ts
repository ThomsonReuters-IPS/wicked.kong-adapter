'use strict';

const request = require('request');
const { debug, info, warn, error } = require('portal-env').Logger('kong-adapter:utils');
const crypto = require('crypto');
import * as wicked from 'wicked-sdk';

const fs = require('fs');
const path = require('path');
const qs = require('querystring');
const async = require('async');

import { SyncStatistics, ConsumerPlugin } from "./types";
import { WickedGroupCollection, Callback, WickedApiPlanCollection, WickedApiPlan, KongApi, KongService, KongRoute, KongPlugin, ErrorCallback, ProtocolType, KongCollection, KongConsumer, KongGlobals, KongStatus } from "wicked-sdk";

const KONG_TIMEOUT = 5000;
const KONG_RETRY_DELAY = 2000;
const KONG_MAX_ATTEMPTS = 10;

export function getUtc(): number {
    return Math.floor((new Date()).getTime() / 1000);
}

export function createRandomId(): string {
    return crypto.randomBytes(20).toString('hex');
}

let _kongUrl: string = null;
export function setKongUrl(url: string): void {
    _kongUrl = url;
}

export function getKongUrl(): string {
    if (!_kongUrl)
        throw new Error('utils.setKongUrl was never called, kong URL is yet unknown');
    return _kongUrl;
}

let _myUrl: string = null;
export function setMyUrl(url: string): void {
    _myUrl = url;
}

export function getMyUrl(): string {
    return _myUrl;
}

export function getJson(ob): object {
    if (typeof ob === "string") {
        if (ob === "")
            return null;
        return JSON.parse(ob);
    }
    return ob;
}

export function getText(ob): string {
    if (typeof ob === "string")
        return ob;
    return JSON.stringify(ob, null, 2);
};

export function clone(ob): any {
    return JSON.parse(JSON.stringify(ob));
};

export function getIndexBy(anArray, predicate): number {
    for (let i = 0; i < anArray.length; ++i) {
        if (predicate(anArray[i]))
            return i;
    }
    return -1;
};

/**
 * Check for left side inclusion in right side, NOT vice versa
 */
export function matchObjects(apiObject, kongObject) {
    debug('matchObjects()');
    const returnValue = matchObjectsInternal(apiObject, kongObject);
    if (!returnValue) {
        debug(' - objects do not match.');
        debug('apiObject: ' + JSON.stringify(apiObject, null, 2));
        debug('kongObject: ' + JSON.stringify(kongObject, null, 2));
        if (_keepChangingActions) {
            // Store mismatching matches; this is a debugging mechanism for the
            // integration tests mostly. Find out which objects do not match and
            // and enable checking on them.
            _statistics.failedComparisons.push({
                apiObject: apiObject,
                kongObject: kongObject
            });
        }
    }
    return returnValue;
};

function matchObjectsInternal(apiObject, kongObject) {
    for (let prop in apiObject) {
        if (!kongObject.hasOwnProperty(prop)) {
            //console.log('Kong object does not have property "' + prop + '".');
            return false;
        }
        if ((typeof apiObject[prop]) != (typeof kongObject[prop]))
            return false;
        if (typeof apiObject[prop] == "object") { // Recurse please
            if (!matchObjectsInternal(apiObject[prop], kongObject[prop]))
                return false;
        } else { // other types
            if (apiObject[prop] != kongObject[prop]) {
                //console.log('Property "' + prop + '" does not match ("' + apiObject[prop] + '" vs "' + kongObject[prop] + '").');
                return false;
            }
        }
    }
    return true;
}

let _kongAvailable = true; // Otherwise the first call will not succeed
let _kongMessage = null;
let _kongClusterStatus = null;
export function markKongAvailable(kongAvailable, kongMessage, clusterStatus) {
    _kongAvailable = kongAvailable;
    _kongMessage = kongMessage;
    _kongClusterStatus = clusterStatus;
}

export function getKongClusterStatus() {
    return _kongClusterStatus;
}

export function isKongAvailable() {
    return _kongAvailable;
}

function defaultStatistics(): SyncStatistics {
    return {
        actions: [],
        failedComparisons: []
    };
}
let _statistics = defaultStatistics();
let _keepChangingActions = false;

/**
 * Resets the counters of actions taken against the Kong API; useful when debugging
 * why changes are redone over and over again, and used specifically in the integration
 * test suite to make sure the models created from the portal API configuration and the
 * ones present in the Kong database match.
 *
 * See also kongMain.resync() (the /resync end point).
*/
export function resetStatistics(keepChangingActions): void {
    _statistics = defaultStatistics();
    if (keepChangingActions)
        _keepChangingActions = true;
    else
        _keepChangingActions = false;
};

/**
 * Retrieves a list of usage statistics, including a list of "changing" API calls
 * to Kong, in case the flag "keep changing settings" was activated when the statistics
 * were reset. This is used in conjunction with the /resync end point to check
 * whether a resync is a complete NOP after the sync queue has already been worked off.
 *
 * Part of the statistics is also a list of objects which did not match when comparing,
 * see "matchObjects" for more information.
 */
export function getStatistics(): SyncStatistics {
    _keepChangingActions = false;
    return _statistics;
};

/**
 * Helper method to record Kong API action statistics, and possible also to record
 * a list of changing API calls for debugging purposes (integration tests).
 */
function kongActionStat(method, url, body): void {
    if (!_statistics[method])
        _statistics[method] = 0;
    _statistics[method]++;
    if (_keepChangingActions &&
        method != 'GET') {
        _statistics.actions.push({
            method: method,
            url: url,
            body: body
        });
    }
}

function kongAction(method, url, body, expectedStatusCode, callback: Callback<any>): void {
    debug(`kongAction(): ${method} "${url}"`);
    kongActionStat(method, url, body);

    // If for some reason, we think Kong is not available, tell the upstream
    if (!_kongAvailable) {
        const err: any = new Error('kong admin end point not available: ' + _kongMessage);
        err.status = 500;
        return callback(err);
    }

    // Now do our thing
    const kongUrl = getKongUrl();
    const methodBody: any = {
        method: method,
        url: kongUrl + url,
        timeout: KONG_TIMEOUT
    };
    if (method != 'DELETE' &&
        method != 'GET') {
        methodBody.json = true;
        methodBody.body = body;
        if (process.env.KONG_CURL)
            console.error('curl -X ' + method + ' -d \'' + JSON.stringify(body) + '\' -H \'Content-Type: application/json\' ' + methodBody.url);
    } else {
        if (process.env.KONG_CURL)
            console.error('curl -X ' + method + ' ' + methodBody.url);
    }

    function tryRequest(attempt: number) {
        request(methodBody, function (err, apiResponse, apiBody) {
            if (err) {
                if (attempt > KONG_MAX_ATTEMPTS) {
                    error(`kongAction: Giving up after ${KONG_MAX_ATTEMPTS} attempts to send a request to Kong.`);
                    // Still open up calls to Kong again now. Otherwise we would get stuck
                    // in a deadlock loop.
                    _kongAvailable = true;
                    return callback(err);
                }
                warn(`kongAction: Failed to send a request to Kong; retrying in ${KONG_RETRY_DELAY} ms (#${attempt+1}). Preventing other calls in the mean time.`);
                _kongAvailable = false;

                setTimeout(tryRequest, KONG_RETRY_DELAY, attempt + 1);
                return;
            }
            _kongAvailable = true;
            if (expectedStatusCode != apiResponse.statusCode) {
                const err: any = new Error('kongAction ' + method + ' on ' + url + ' did not return the expected status code (got: ' + apiResponse.statusCode + ', expected: ' + expectedStatusCode + ').');
                err.status = apiResponse.statusCode;
                debug(method + ' /' + url);
                debug(methodBody);
                debug(apiBody);
                //console.error(apiBody);
                return callback(err);
            }
            callback(null, getJson(apiBody));
        });
    }

    tryRequest(0);
}

function kongGet(url: string, callback: Callback<any>) {
    kongAction('GET', url, null, 200, callback);
};

function kongPost(url, body, callback) {
    kongAction('POST', url, body, 201, callback);
};

function kongDelete(url, callback) {
    kongAction('DELETE', url, null, 204, callback);
};

function kongPatch(url, body, callback) {
    kongAction('PATCH', url, body, 200, callback);
};

export function getPlan(planId: string, callback: Callback<WickedApiPlan>) {
    debug('getPlan() - ' + planId);
    getPlans(function (err, plans) {
        if (err)
            return callback(err);
        internalGetPlan(plans, planId, callback);
    });
};

let _plans: WickedApiPlanCollection = null;
export function getPlans(callback: Callback<WickedApiPlanCollection>): void {
    debug('getPlans()');
    if (!_plans) {
        wicked.getPlans(function (err, results) {
            if (err)
                return callback(err);
            _plans = results;
            return callback(null, _plans);
        });
    } else {
        return callback(null, _plans);
    }
};

function internalGetPlan(plans: WickedApiPlanCollection, planId, callback: Callback<WickedApiPlan>): void {
    const plan = plans.plans.find(p => p.id === planId);
    if (!plan)
        return callback(new Error('Unknown plan ID: ' + planId));
    return callback(null, plan);
}

let _groups: WickedGroupCollection = null;
export function getGroups(): WickedGroupCollection {
    debug(`getGroups()`);
    if (!_groups)
        throw new Error('utils: _groups is not initialized; before calling getGroups(), initGroups() must have been called.');
    return _groups;
};

/**
 * Initialize the cache for the wicked user groups so that getGroups() can be
 * implemented synchronuously.
 * 
 * @param callback 
 */
export function initGroups(callback: Callback<WickedGroupCollection>): void {
    debug(`initGroups()`);
    wicked.getGroups((err, groups) => {
        if (err)
            return callback(err);
        _groups = groups;
        return callback(null, groups);
    });
};

export function findWithName(someArray: any[], name: string): any {
    for (let i = 0; i < someArray.length; ++i) {
        if (someArray[i].name === name)
            return someArray[i];
    }
    return null;
};

export function makeUserName(appId, apiId) {
    return appId + '$' + apiId;
};

let _packageFile = null;
export function getPackageJson() {
    if (!_packageFile) {
        // Deliberately do not do any error handling here! package.json MUST exist.
        const packageFile = path.join(__dirname, '..', 'package.json');
        _packageFile = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    }
    return _packageFile;
};

let _packageVersion = null;
export function getVersion() {
    if (!_packageVersion) {
        const packageInfo = getPackageJson();
        if (packageInfo.version)
            _packageVersion = packageInfo.version;
    }
    if (!_packageVersion) // something went wrong
        _packageVersion = "0.0.0";
    return _packageVersion;
};

let _expectedKongVersion = null;
export function getExpectedKongVersion() {
    if (!_expectedKongVersion) {
        const packageInfo = getPackageJson();
        if (packageInfo.config && packageInfo.config.kongversion)
            _expectedKongVersion = packageInfo.config.kongversion;
    }
    if (!_expectedKongVersion)
        throw new Error('package.json does not contain config.kongversion!');
    return _expectedKongVersion;
};

let _gitLastCommit = null;
export function getGitLastCommit() {
    if (!_gitLastCommit) {
        const lastCommitFile = path.join(__dirname, '..', 'git_last_commit');
        if (fs.existsSync(lastCommitFile))
            _gitLastCommit = fs.readFileSync(lastCommitFile, 'utf8');
        else
            _gitLastCommit = '(no last git commit found - running locally?)';
    }
    return _gitLastCommit;
};

let _gitBranch = null;
export function getGitBranch() {
    if (!_gitBranch) {
        const gitBranchFile = path.join(__dirname, '..', 'git_branch');
        if (fs.existsSync(gitBranchFile))
            _gitBranch = fs.readFileSync(gitBranchFile, 'utf8');
        else
            _gitBranch = '(unknown)';
    }
    return _gitBranch;
};

let _buildDate = null;
export function getBuildDate() {
    if (!_buildDate) {
        const buildDateFile = path.join(__dirname, '..', 'build_date');
        if (fs.existsSync(buildDateFile))
            _buildDate = fs.readFileSync(buildDateFile, 'utf8');
        else
            _buildDate = '(unknown build date)';
    }
    return _buildDate;
};

// KONG Convenience functions (typed)

// Don't use this if you don't have to, it's for super special cases.
// Usually, please create a named wrapper function for the Kong API call.
export function kongGetRaw(url: string, callback: Callback<object>): void {
    kongGet(url, callback);
}

// Service functions
function kongGetAllServices(callback: Callback<KongCollection<KongService>>): void {
    kongGet('services?size=100000', callback);
}

function kongPostService(service: KongService, callback: Callback<KongService>): void {
    kongPost('services', service, callback);
}

function kongPatchService(serviceId: string, service: KongService, callback: Callback<KongService>): void {
    kongPatch(`services/${serviceId}`, service, callback);
}

function kongDeleteService(serviceId: string, callback: ErrorCallback): void {
    kongDelete(`services/${serviceId}`, callback);
}

// Route functions
function kongGetAllRoutes(callback: Callback<KongCollection<KongRoute>>): void {
    kongGet('routes?size=100000', callback);
}

function kongPostRoute(route: KongRoute, callback: Callback<KongRoute>): void {
    kongPost('routes', route, callback);
}

function kongPatchRoute(routeId: string, route: KongRoute, callback: Callback<KongRoute>): void {
    kongPatch(`routes/${routeId}`, route, callback);
}

function kongDeleteRoute(routeId: string, callback: ErrorCallback) {
    kongDelete(`routes/${routeId}`, callback);
}

function kongGetRouteForService(serviceId: string, callback: Callback<KongRoute>): void {
    kongGet(`services/${serviceId}/routes`, function (err, routes: KongCollection<KongRoute>) {
        if (err)
            return callback(err);
        if (routes.data.length === 0)
            return callback(null, null);
        if (routes.data.length === 1)
            return callback(null, routes.data[0]);
        warn(`kongGetRouteForService(${serviceId}): Multiple routes found, returning the first one.`);
        return callback(null, routes.data[0]);
    })
}

// API functions
export function kongGetAllApis(callback: Callback<KongCollection<KongApi>>): void {
    debug('kongGetAllApis()');
    async.parallel({
        services: callback => kongGetAllServices(callback),
        routes: callback => kongGetAllRoutes(callback)
    }, function (err, results) {
        if (err)
            return callback(err);
        const services = results.services as KongCollection<KongService>;
        const routes = results.routes as KongCollection<KongRoute>;

        // Step 1: Build a service id to service map
        const serviceIdMap = new Map<string, KongService>();
        for (let i = 0; i < services.data.length; ++i) {
            const s = services.data[i];
            serviceIdMap.set(s.id, s);
        }
        // Step 2: Match the routes to the services
        const kongApis: KongApi[] = [];
        for (let i = 0; i < routes.data.length; ++i) {
            const r = routes.data[i];
            if (!serviceIdMap.has(r.service.id)) {
                warn(`kongGetAllApis: Route ${r.id} with paths ${r.paths} has an unknown service id ${r.service.id}`);
                continue;
            }
            kongApis.push(wicked.kongServiceRouteToApi(serviceIdMap.get(r.service.id), r));
        }

        return callback(null, {
            data: kongApis
        });
    });
    // kongGet('apis?size=1000000', callback);
}

export function kongGetApiPlugins(apiId: string, callback: Callback<KongCollection<KongPlugin>>): void {
    debug(`kongGetApiPlugins(${apiId})`);
    // kongGet(`apis/${apiId}/plugins?size=1000000`, callback);
    kongGet(`services/${apiId}/plugins?size=1000000`, callback);
}

export function kongPostApi(apiConfig: KongApi, callback: Callback<KongApi>): void {
    debug('kongPostApi()');
    const { service, route } = wicked.kongApiToServiceRoute(apiConfig);
    let persistedService: KongService = null;
    let persistedRoute: KongRoute = null;
    async.waterfall([
        callback => kongPostService(service, callback),
        (s: KongService, callback) => {
            persistedService = s;
            route.service = {
                id: s.id
            }
            kongPostRoute(route, callback);
        },
        (r: KongRoute, callback) => {
            persistedRoute = r;
            return callback(null);
        }
    ], (err) => {
        if (err)
            return callback(err);
        return callback(null, wicked.kongServiceRouteToApi(persistedService, persistedRoute));
    })
    //kongPost('apis', apiConfig, callback);
}

export function kongPatchApi(apiId: string, apiConfig: KongApi, callback: Callback<KongApi>): void {
    debug(`kongPatchApi(${apiId})`);
    const { service, route } = wicked.kongApiToServiceRoute(apiConfig);
    service.id = apiId;
    kongGetRouteForService(apiId, function (err, existingRoute) {
        if (err)
            return err;
        if (!existingRoute)
            return callback(new Error(`Could not retrieve route for service ${apiId}`));
        route.id = existingRoute.id;
        route.service = { id: existingRoute.service.id };
        async.series({
            persistedService: callback => kongPatchService(apiId, service, callback),
            persistedRoute: callback => kongPatchRoute(route.id, route, callback)
        }, function (err, results) {
            return callback(null, wicked.kongServiceRouteToApi(results.persistedService, results.persistedRoute));
        })
    });
    //kongPatch(`apis/${apiId}`, apiConfig, callback);
}

export function kongDeleteApi(apiId: string, callback: ErrorCallback): void {
    debug(`kongDeleteApi(${apiId})`);
    kongGetRouteForService(apiId, function (err, route) {
        if (err)
            return callback(err);
        kongDeleteRoute(route.id, function (err) {
            if (err)
                return callback(err);
            kongDeleteService(apiId, callback);
        })
    });
    //kongDelete(`apis/${apiId}`, callback);
}

export function kongPostApiPlugin(apiId: string, plugin: KongPlugin, callback: Callback<KongPlugin>): void {
    debug(`kongPostApiPlugin(${apiId}, ${plugin.name})`);
    //kongPost(`apis/${apiId}/plugins`, plugin, callback);
    kongPost(`services/${apiId}/plugins`, plugin, callback);
}

export function kongPatchApiPlugin(apiId: string, pluginId: string, plugin: KongPlugin, callback: Callback<KongPlugin>): void {
    debug(`kongPatchApiPlugin(${apiId}, ${plugin.name})`);
    // //kongPatch(`apis/${apiId}/plugins/${pluginId}`, plugin, callback);
    // if (plugin.service_id !== apiId)
    //     throw new Error('PATCH API/Service Plugin: apiId does not match serviceId in plugin');
    plugin.service_id = apiId;
    plugin.id = pluginId;
    kongPatch(`plugins/${pluginId}`, plugin, callback);
}

export function kongDeleteApiPlugin(apiId: string, pluginId: string, callback: ErrorCallback): void {
    debug(`kongDeleteApiPlugin(${apiId}, ${pluginId})`);
    //kongDelete(`apis/${apiId}/plugins/${pluginId}`, callback);
    kongDeletePlugin(pluginId, callback);
}

// Consumer functions
export function kongGetAllConsumers(callback: Callback<KongCollection<KongConsumer>>): void {
    kongGet('consumers?size=100000', callback);
}

export function kongGetConsumersByCustomId(customId: string, callback: Callback<KongCollection<KongConsumer>>): void {
    kongGet('consumers?custom_id=' + qs.escape(customId), callback);
}

export function kongGetConsumerByName(username: string, callback: Callback<KongConsumer>): void {
    kongGet(`consumers/${username}`, callback);
}

export function kongGetConsumerPluginData(consumerId: string, pluginName: string, callback: Callback<KongCollection<object>>): void {
    kongGet(`consumers/${consumerId}/${pluginName}`, callback);
}

export function kongGetApiPluginsByConsumer(apiId: string, consumerId: string, callback: Callback<KongCollection<KongPlugin>>): void {
    kongGet(`services/${apiId}/plugins?consumer_id=${qs.escape(consumerId)}`, callback);
}

export function kongPostConsumer(consumer: KongConsumer, callback: Callback<KongConsumer>): void {
    kongPost('consumers', consumer, callback);
}

export function kongPostConsumerPlugin(consumerId: string, pluginName: string, plugin: ConsumerPlugin, callback: Callback<KongPlugin>): void {
    kongPost(`consumers/${consumerId}/${pluginName}`, plugin, callback);
}

export function kongDeleteConsumerPlugin(consumerId: string, pluginName: string, pluginId: string, callback: ErrorCallback): void {
    kongDelete(`consumers/${consumerId}/${pluginName}/${pluginId}`, callback);
}

export function kongPatchConsumer(consumerId: string, consumer: KongConsumer, callback: Callback<KongConsumer>): void {
    kongPatch(`consumers/${consumerId}`, consumer, callback);
}

export function kongDeleteConsumer(consumerId: string, callback: ErrorCallback): void {
    kongDelete(`consumers/${consumerId}`, callback);
}

// OTHER FUNCTIONS

export function kongGetGlobals(callback: Callback<KongGlobals>): void {
    kongGet('', callback);
}

export function kongGetStatus(callback: Callback<KongStatus>): void {
    kongGet('status', callback);
}

// Global Plugin functions

export function kongGetPluginsByName(pluginName: string, callback: Callback<KongCollection<KongPlugin>>): void {
    kongGet(`plugins?name=${qs.escape(pluginName)}&size=1000000`, callback);
}

export function kongPostGlobalPlugin(plugin: KongPlugin, callback: Callback<KongPlugin>): void {
    kongPost('plugins', plugin, callback);
}

export function kongDeletePlugin(pluginId: string, callback: ErrorCallback): void {
    kongDelete(`plugins/${pluginId}`, callback);
}
