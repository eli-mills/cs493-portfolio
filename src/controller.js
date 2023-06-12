const express = require('express');
const db = require('./model');
const { auth } = require('express-openid-connect');
const {expressjwt: jwt} = require('express-jwt');
const jwksRsa = require('jwks-rsa');
const jwt_decode = require('jwt-decode');
const {wrap} = require('async-middleware');
const DOMAIN = "millse2-cs493-portfolio.us.auth0.com";

/****************************************************************
 *                                                              *
 *                     LIBRARY MIDDLEWARE                       *
 *                                                              *
****************************************************************/

const authMiddleware = auth({
    authRequired: false,
    auth0Logout: true,
    baseURL: process.env.NODE_ENV === "production" ? "https://millse2-cs493-portfolio.uk.r.appspot.com" : 'http://localhost:3000',
    issuerBaseURL: `https://${DOMAIN}`
});

const checkJwt = jwt({
    secret: jwksRsa.expressJwtSecret({
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 5,
      jwksUri: `https://${DOMAIN}/.well-known/jwks.json`
    }),
  
    // Validate the audience and the issuer.
    issuer: `https://${DOMAIN}/`,
    algorithms: ['RS256']
  });

/****************************************************************
 *                                                              *
 *                 CUSTOM MIDDLEWARE - UTILITY                  *
 *                                                              *
****************************************************************/

// STATIC (link generators)
/**
 * 
 * @param {Object} req 
 * @param {string} collectionUrl 
 * @returns {string} spliced protocol, host, and mounted route
 */
function getFullBaseUrl(req, collectionUrl=undefined) {
    const baseUrl = collectionUrl || req.baseUrl;
    return `${req.protocol}://${req.get("host")}${baseUrl}`;
}

/**
 * 
 * @param {Object} req 
 * @returns {string} usable 'next' link for pagination with cursor as query parameter
 */
function getNextLink(req) {
    const cursor = req.retrievedMetaData.cursor;
    return cursor ? `${getFullBaseUrl(req)}?cursor=${cursor}` : undefined;
}

// VALIDATION
/**
 * Exits early from route if authenticated user does not match retrieved entities.
 * 
 * @param {Object} req 
 * @param {Object} res 
 * @param {Object} next 
 * @returns 
 */
function assertCorrectOwner(req, res, next) {
    const entitiesObject = req.retrievedEntities || {entity: req.retrievedEntity};
    for (const entity of Object.values(entitiesObject)) {
        const owner = entity.user;
        if (owner !== req.auth.sub) return res.status(403).json({"Error": "The authorized user does not have access to this endpoint."});
    }
    return next();
}

/**
 * Exits early from route if requested Accept header is not supported.
 * 
 * @param {Object} req 
 * @param {Object} res 
 * @param {Object} next 
 * @returns 
 */
function assertAcceptJson(req, res, next) {
    if (!req.accepts("json")) {
        return res.status(406).json({"Error": "Requested MIME type is not supported."});
    }
    return next();
}

/**
 * Exits early from route if supplied Content-type is not supported.
 * 
 * @param {Object} req 
 * @param {Object} res 
 * @param {Object} next 
 * @returns 
 */
function assertContentJson(req, res, next) {
    if (! (req.get("Content-type") === "application/json")) {
        return res.status(415).json({"Error": "Request body contains unsupported MIME type."});
    }
    next();
}


// DATA PIPELINE
/**
 * Middleware factory. Queries DB with given kind and route parameter id.
 * Saves result to the request object as the property retrievedEntity.
 * Exits route early if entity cannot be found.
 * 
 * @param {string} kind 
 * @returns middleware function
 */
function getEntityFromParams(kind) {
    const middlewareFn = async (req, res, next) => {
        const retrievedEntity = await db.getEntity(kind, req.params.id);
        if (!retrievedEntity) return res.status(404).json({"Error": `No ${kind.toLowerCase()} with this ${kind.toLowerCase()}_id exists.`});
        req.retrievedEntity = retrievedEntity;
        return next();
    }
    return middlewareFn;
}

/**
 * Queries DB with given boat and load id's from route parameters.
 * Saves results to the request object as the property retrievedEntities.
 * Exits route early if either entity cannot be found.
 * 
 * @param {Object} req 
 * @param {Object} res 
 * @param {Object} next 
 * @returns 
 */
async function getEntitiesFromParams(req, res, next) {
    const boat = await db.getEntity("Boat", req.params.boatId);
    const load = await db.getEntity("Load", req.params.loadId);
    if (!boat || !load) return res.status(404).json({"Error": "The specified boat and/or load does not exist."});

    // Both retrieved
    req.retrievedEntities = {boat, load};
    return next();
}

/**
 * Interrogates request object for retrievedEntities or retrievedEntity.
 * Adds 'self' link for every valid entity with an id and kind.
 * Recurses for the case of a load with a carrier.
 * 
 * @param {Object} req 
 * @param {Object} res 
 * @param {Object} next 
 * @returns 
 */
function addSelfLinksToResponseList(req, res, next) {
    const entities = req.retrievedEntities || [req.retrievedEntity];
    for (const entity of entities) {
        entity.self = `${getFullBaseUrl(req)}/${entity.id}`;
        if (entity.carrier) {
            entity.carrier.self = `${getFullBaseUrl(req, "/boats")}/${entity.carrier.id}`;
        }
    }
    
    return next();
}

/**
 * For pagination, adds the count and next link to req.retrievedEntities.
 * 
 * @param {Object} req 
 * @param {Object} res 
 * @param {Object} next 
 * @returns 
 */
function addMetaData(req, res, next) {
    const nextLink = getNextLink(req);
    const dataToSend = {
        count: req.retrievedMetaData.count,
        next: nextLink,
        data: req.retrievedEntities
    }
    req.retrievedEntities = dataToSend;
    return next();
}

/**
 * Sends data from either retrievedEntity or retrievedEntities.
 * Response is expected to be set prior.
 * 
 * @param {Object} req 
 * @param {Object} res 
 * @returns 
 */
function sendData(req, res) {
    const dataToSend = req.retrievedEntity || req.retrievedEntities;
    return res.json(dataToSend);
}

/**
 * On boat deletion, finds loads with this boat as their carrier and
 * sets carrier to null.
 * 
 * @param {Object} req 
 * @param {Object} res 
 * @returns 
 */
async function updateLoads(req, res) {
    if (req.baseUrl !== "/boats") return res.end();
    
    // Boat deleted. Find loads that were assigned to Boat.
    const deletedBoat = req.retrievedEntity;
    const loadsToUpdate = await db.getAllEntities("Load", ["carrier.id", "=", deletedBoat.id]);
    for (const load of loadsToUpdate) {
        load.carrier = null;
        await db.replaceEntity(load);
    }
    return res.end();
}

// EXCEPTION HANDLING
/**
 * Exits route and sends response if bad request due to invalid data.
 * 
 * @param {Error} err 
 * @param {Object} req 
 * @param {Object} res 
 * @param {Object} next 
 * @returns 
 */
function handleValidationError(err, req, res, next) {
    if (! (err instanceof db.EntityValidationError)) return next(err);
    console.error(err);
    res.status(400).json({"Error": "One or more of the request attributes are missing or invalid."});
}

/**
 * Catches unallowed request methods.
 * 
 * @param {Object} req 
 * @param {Object} res 
 * @returns 
 */
function methodNotAllowed(req, res) {
    return res.status(405).end();
}

/****************************************************************
 *                                                              *
 *              CUSTOM MIDDLEWARE - ROUTER MAINS                *
 *                                                              *
****************************************************************/

// POST
function mwPostEntity(kind) {
    const middlewareFn = async (req, res, next) => {
        req.body.user = req.auth.sub;
        try {
            const newBoat = await db.storeNewEntity(kind, req.body);
            req.retrievedEntity = newBoat;
            res.status(201);
            return next();
        } catch (e) {
            // Pass to middleware to check if EntityValidationError
            return next(e);
        }
    }
    return middlewareFn;
}

// GET
function mwGetAllEntities(kind) {
    const middlewareFn = async (req, res, next) => {
        const [usersEntities, cursor, count] = await db.getAllEntitiesPaginated(kind, req.auth.sub, req.query.cursor);
        req.retrievedEntities = usersEntities;
        req.retrievedMetaData = {cursor, count};
        
        console.log(cursor);
        res.status(200);
        return next();
    }
    return middlewareFn;
}

async function mwGetEntity (req, res, next) {
    res.status(200);
    return next();
}

// PATCH
async function mwPatchEntity(req, res, next) {
    const retrievedEntity = req.retrievedEntity;
    try {
        req.retrievedEntity = await db.updateEntity(retrievedEntity, req.body);
        if (!req.retrievedEntity) {
            return res.status(500).end();
        }
        res.status(200);
        return next();
    } catch (err) {
        return next(err);
    }
}

// PUT
async function mwPutEntity (req, res, next) {
    req.body.user = req.auth.sub;
    const retrievedEntity = req.retrievedEntity;
    try {
        req.retrievedEntity = await db.replaceEntity(retrievedEntity, req.body);
        if (!req.retrievedEntity) {
            return res.status(500).end();
        }
        res.status(200);
        return next();
    } catch (err) {
        return next(err);
    }
}

// DELETE
async function mwDeleteEntity(req, res, next) {
    const entityToDelete = req.retrievedEntity;
    if (! await db.deleteEntity(entityToDelete)) {
        return res.status(500).end();
    };
    res.status(204);
    return next();
}

/****************************************************************
 *                                                              *
 *                   ENTITY ROUTER FACTORY                      *
 *                                                              *
****************************************************************/
function generateEntityRouter(kind) {
    router = express.Router();
    router.route("/")
    .all(checkJwt)
    .get(checkJwt, wrap(mwGetAllEntities(kind)), addSelfLinksToResponseList, addMetaData, sendData)
    .post(assertContentJson, assertAcceptJson, wrap(mwPostEntity(kind)), addSelfLinksToResponseList, sendData)
    .all(methodNotAllowed);
    
    router.route("/:id")
    .all(checkJwt, wrap(getEntityFromParams(kind)), assertCorrectOwner)
    .get(assertAcceptJson, wrap(mwGetEntity))
    .patch(assertAcceptJson, assertContentJson, wrap(mwPatchEntity))
    .put(assertAcceptJson, assertContentJson, wrap(mwPutEntity))
    .delete(wrap(mwDeleteEntity), updateLoads)
    .all(addSelfLinksToResponseList, sendData);
    
    router.use(handleValidationError);

    return router;
}

/****************************************************************
 *                                                              *
 *                          ROUTERS                             *
 *                                                              *
****************************************************************/

// INITIALIZE ROUTERS
const authentication = express.Router();
const users = express.Router();
const boats = generateEntityRouter("Boat");
const loads = generateEntityRouter("Load");

// AUTHENTICATION
authentication.use(authMiddleware);
authentication.get("/", wrap(async (req, res, next) => {
    if (!req.oidc.isAuthenticated()) {
        return next();         // Use Express static middleware to display login page.
    }
    const decoded = jwt_decode(req.oidc.idToken);
    await db.storeNewEntity("User", {sub: decoded.sub});
    res.status(303).redirect("/user-info");
}));
authentication.get("/user-info", (req, res) => {
    res.json({token: req.oidc.idToken, sub: jwt_decode(req.oidc.idToken).sub});
});

// USERS
users.get("/", assertAcceptJson, async (req, res) => {
    const allUsers = await db.getAllEntities("User");
    res.status(200).json(allUsers);
});

// BOAT/LOAD RELATIONSHIP
boats.route("/:boatId/loads/:loadId")
.all(checkJwt, wrap(getEntitiesFromParams), assertCorrectOwner)
.put(wrap(async (req, res) => {
    const load = req.retrievedEntities.load;
    const boat = req.retrievedEntities.boat;
    if (load.carrier !== null) return res.status(403).json({"Error": "The load is already loaded on another boat."});
    
    // Load can be assigned
    load.carrier = boat;
    await db.replaceEntity(load);
    res.status(204).end();
}))
.delete(wrap(async (req, res) => {
    const load = req.retrievedEntities.load;
    const boat = req.retrievedEntities.boat;
    if (load.carrier === null || load.carrier.id !== boat.id) {
        return res.status(404).json({"Error": "The specified boat/load pair does not exist."});
    }
    // Load can be removed
    load.carrier = null;
    await db.replaceEntity(load);
    res.status(204).end();
}));

/****************************************************************
 *                                                              *
 *                          EXPORTS                             *
 *                                                              *
****************************************************************/
module.exports = {
    authentication,
    boats,
    loads,
    users,
}