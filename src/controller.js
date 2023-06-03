const express = require('express');
const db = require('./model');
const { auth } = require('express-openid-connect');
const {expressjwt: jwt} = require('express-jwt');
const jwksRsa = require('jwks-rsa');
const DOMAIN = "millse2-cs493-a7.us.auth0.com";

// INITIALIZE ROUTERS
const authentication = express.Router();
const boats = express.Router();
const owners = express.Router();

// LIBARY MIDDLEWARE
const authMiddleware = auth({
    authRequired: false,
    auth0Logout: true,
    baseURL: process.env.NODE_ENV === "production" ? "https://millse2-cs493-a7.uk.r.appspot.com" : 'http://localhost:3000',
    issuerBaseURL: 'https://millse2-cs493-a7.us.auth0.com'
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
 *                          ROUTERS                             *
 *                                                              *
****************************************************************/

// AUTHENTICATION
authentication.use(authMiddleware);
authentication.get("/", (req, res, next) => {
    if (!req.oidc.isAuthenticated()) {
        return next();         // Use Express static middleware to display login page.
    }
    res.status(303).redirect("/user-info");
});
authentication.get("/user-info", (req, res) => {
    res.json(req.oidc.idToken);
});

// BOATS
boats.route("/")
    .get(checkJwt, async (req, res) => {
        // User is authenticated
        const allBoats = await db.getAllEntities("Boat");
        const usersBoats = allBoats.filter(boat => boat.owner === req.auth.sub);
        res.status(200).json(usersBoats);
    })
    // Error handler for boats.get
    .get(async (err, req, res, next) => {
        if (err.name === "UnauthorizedError") {
            // User is unauthenticated
            const allBoats = await db.getAllEntities("Boat");
            const allPublicBoats = allBoats.filter(boat => boat.public);
            res.status(200).json(allPublicBoats);
        } else {
            // Some other error, pass to Express
            console.error(err);
            next(err);
        }
    })
    .post(checkJwt, async (req, res) => {
        req.body.owner = req.auth.sub;
        const newBoat = await db.createBoat(req.body);
        res.status(201).json(newBoat);
    });

boats.delete("/:boatId", checkJwt, async (req, res) => {
    const boatToDelete = await db.getEntity("Boat", req.params.boatId);
    if (!boatToDelete || boatToDelete.owner !== req.auth.sub) {
        // ID doesn't exist or owner is unauthorized
        res.status(403).end();
        return;
    }
    db.deleteEntity(boatToDelete);
    res.status(204).end();
});

// OWNERS
owners.get("/:ownerId/boats", async (req, res) => {
    const allBoats = await db.getAllEntities("Boat");
    const boatsByOwner = allBoats.filter(boat => boat.public && boat.owner === req.params.ownerId);
    res.status(200).json(boatsByOwner);
});

/****************************************************************
 *                                                              *
 *                          EXPORTS                             *
 *                                                              *
****************************************************************/
module.exports = {
    authentication,
    boats,
    owners,
}