const {Datastore} = require('@google-cloud/datastore');
const datastore = new Datastore();

class EntityValidationError extends Error {}

/**
 * Defines common data validation methods for Datastore Entities.
 */
class Entity {
    /**
     * 
     * @returns true if any of the instance's properties are undefined, else false
     */

    constructor() {
        this.validationMethods = {
            minLength: (str, min) => {return str.length < min},
            maxLength: (str, max) => {return str.length > max},
            minVal: (num, min) => {return num < min},
            maxVal: (num, max) => {return num > max},
            ofForm: (str, re) => {return re.test(str)}
        }
    }

    getEntityData() {
        throw Error("This method is not implemented in parent and should be overridden.")
    }

    getEntityKey(kind) {
        throw Error("This method is not implemented in parent and should be overridden.")
    }

    propsAreMissing() {
        return Object.values(this).reduce((acc, cur)=>acc || cur === undefined, false);
    }

    propFailsValidationRules() {
        for (const [prop, rules] of Object.entries(this.validation)) {
            for (const [rule, allowedValue] of Object.entries(rules)) {
                const validationRule = this.validationMethods[rule];
                const actualValue = this[prop];
                if (validationRule(actualValue, allowedValue)) {
                    return true;
                }
            }
        }
        return false;
    }

    instanceIsInvalid() {
        return this.propsAreMissing() || this.propFailsValidationRules();
    }
    
    validateInstance() {
        if (this.instanceIsInvalid()) {
            throw new EntityValidationError(`${this.constructor.name} instance failed to validate with properties ${JSON.stringify(this.getEntityData())}`)
        }
    }
}

/**
 * Defines data structure to use when creating a new boat.
 */
class Boat extends Entity{
    /**
     * 
     * @param {string} name 
     * @param {string} type 
     * @param {int} length
     * @param {string} user 
     */
    constructor({name, type, length, user}) {
        super();
        // Signature defines required properties. Missing will be undefined.
        this.name = name;
        this.type = type;
        this.length = length;
        this.user = user;
        this.validation = {
            name: {
                minLength: 1,
                maxLength: 50
            },
            type: {
                minLength: 1,
                maxLength: 50
            },
            length: {
                minVal: 1,
                maxVal: 9999
            }
        }
        this.validateInstance();
    }

    getEntityData() {
        return {name: this.name, type: this.type, length: this.length, user: this.user}
    }

    getEntityKey(kind) {
        return datastore.key(kind);
    }

}

class Load extends Entity{
    constructor({volume, item, creation_date, user}) {
        super();
        this.volume = volume;
        this.item = item;
        this.creation_date = creation_date;
        this.user = user;
        this.validation = {
            volume: {
                minVal: 1,
                maxVal: 9999
            }, 
            item: {
                minLength: 1,
                maxLength: 50
            },
            creation_date: {
                ofForm: /^\d{2}\/\d{2}\/\d{4}$/
            }
        }
        this.validateInstance();
    }

    getEntityData() {
        return {volume: this.volume, item: this.item, creation_date: this.creation_date, user: this.user}
    }

    getEntityKey(kind) {
        return datastore.key(kind);
    }

}

class User extends Entity {
    constructor({sub}) {
        super();
        this.sub = sub;
    }

    getEntityData() {
        return {sub: this.sub}
    }

    getEntityKey(kind) {
        return datastore.key([kind, this.sub]);
    }

}

/****************************************************************
 *                                                              *
 *                      DATABASE FUNCTIONS                      *
 *                                                              *
 ****************************************************************/

function handleError(err) {
    console.error(err);
    return false;
}

/**
 * Adds a new entity to the database.
 * 
 * @param {object} Object containing all entity properties
 * 
 * @returns new entity, or false if error.
 */
async function createEntity(kind, entityData) {
    const newInstance = {
        "Boat": () => {return new Boat(entityData)},
        "Load": () => {return new Load(entityData)},
        "User": () => {return new User(entityData)},
    }[kind]();
    const newEntity = {
        key: newInstance.getEntityKey(kind),
        data: newInstance.getEntityData()
    }
    try {
        await datastore.save(newEntity);
        console.log(JSON.stringify(newEntity.key));
        return await getEntity(kind, newEntity.key.id || newEntity.key.name,!newEntity.key.hasOwnProperty("id"));
    } catch(err) {
        return handleError(err);
    }
}

/**
 * Retrieves an entity of the given kind with the given id from database.
 * 
 * @param {string} kind
 * @param {string} entityId 
 * @returns matching object, or false if not found
 */
async function getEntity(kind, entityId, isName=false) {
    const id = isName ? entityId : datastore.int(entityId);
    const key = datastore.key([kind, id]);
    try {
        const [retrievedEntity] = await datastore.get(key);
        retrievedEntity.id = retrievedEntity[Datastore.KEY].id;
        console.log(JSON.stringify(retrievedEntity));
        return retrievedEntity;
    } catch (err) {
        return handleError(err);
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
        return handleError(err);
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
        return handleError(err);
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
        return handleError(err);
    }
}

module.exports = {
    getEntity,
    createEntity,
    getAllEntities,
    updateEntity,
    deleteEntity,
    EntityValidationError,
};