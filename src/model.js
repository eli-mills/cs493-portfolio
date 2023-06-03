const {Datastore} = require('@google-cloud/datastore');
const datastore = new Datastore();

/**
 * Defines data structure to use when creating a new boat.
 */
class Boat {
    /**
     * 
     * @param {string} name 
     * @param {string} type 
     * @param {int} length 
     * @param {boolean} public 
     * @param {string} owner 
     */
    constructor({name, type, length, public: isPublic, owner}) {
        this.name = name;
        this.type = type;
        this.length = length;
        this.public = isPublic; 
        this.owner = owner;
    }
}

/****************************************************************
 *                                                              *
 *                      DATABASE FUNCTIONS                      *
 *                                                              *
 ****************************************************************/
/**
 * Adds a new boat to the database.
 * 
 * @param {object} Object containing all boat properties
 * 
 * @returns new boat, or false if error.
 */
async function createBoat(boatData) {
    const newBoat = {
        key: datastore.key('Boat'),
        data: new Boat(boatData)
    }
    try {
        await datastore.save(newBoat);
        return await getEntity("Boat", newBoat.key.id);
    } catch(err) {
        console.error(err);
        return false;
    }
}

/**
 * Retrieves an entity of the given kind with the given id from database.
 * 
 * @param {string} kind
 * @param {string} entityId 
 * @returns matching object, or false if not found
 */
async function getEntity(kind, entityId) {
    const key = datastore.key([kind, datastore.int(entityId)]);
    try {
        const [retrievedEntity] = await datastore.get(key);
        retrievedEntity.id = retrievedEntity[Datastore.KEY].id;
        return retrievedEntity;
    } catch (err) {
        console.error(err);
        return false;
    }
}

/**
 * Retrieves all entities of the given kind from the database.
 * 
 * @param {string} kind
 * @returns list of objects, or error.
 */
async function getAllEntities(kind) {
    const query = datastore.createQuery(kind);
    try {
        const [entities] = await datastore.runQuery(query);
        entities.forEach((entity) => entity.id = entity[Datastore.KEY].id);
        return entities;
    } catch (err) {
        console.error(err);
        return err
    }
}

/**
 * Updates the datastore-retrieved entity object to have the object's current properties.
 * 
 * @param {object} entity: previously retrieved from datastore (has KEY Symbol)
 * @returns true if successful, false if error
 */
async function updateEntity(entity) {
    try {
        await datastore.save(entity);
        return true;
    } catch (err) {
        console.error(err);
        return false;
    }
}

/**
 * Deletes the given entity from the database.
 * 
 * @param {object} entity: previously retrieved from datastore (has KEY Symbol)
 * @returns true if successful, false if error
 */
async function deleteEntity(entity) {
    try {
        await datastore.delete(entity[Datastore.KEY]);
        return true;
    } catch (err) {
        console.error(err);
        return false;
    }
}

module.exports = {
    getEntity,
    createBoat,
    getAllEntities,
    updateEntity,
    deleteEntity,
};