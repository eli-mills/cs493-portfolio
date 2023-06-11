const { Datastore, PropertyFilter } = require('@google-cloud/datastore');
const datastore = new Datastore();
const PAGE_SIZE = 5;

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
        this.validation = {};
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
            for (const rule of rules) {
                if (!rule(this[prop])) {
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
            name: [
                name => name.length >= 1 && name.length <= 50,
            ],
            type: [
                type => type.length >= 1 && type.length <= 50,
            ],
            length: [
                length => length >=1 && length <= 9999,
                length => Number.isInteger(length),
            ]
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
            volume: [
                vol => vol >= 1 && vol <= 9999,
            ], 
            item: [
                item => item.length >= 1 && item.length <= 50,
            ],
            creation_date: [
                date => /^\d{2}\/\d{2}\/\d{4}$/.test(date),
            ]
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
        await addCounter(kind, 1);
        return await getEntity(kind, newEntity.key.id || newEntity.key.name,!newEntity.key.hasOwnProperty("id"));
    } catch(err) {
        return handleError(err);
    }
}

/**
 * 
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
async function getAllEntities(kind, filter=null, startCursor=null) {
    let query = datastore.createQuery(kind).limit(PAGE_SIZE);
    if (filter) {
        propFilter = new PropertyFilter(...filter);
        query = query.filter(propFilter);
    }
    if (startCursor) query = query.start(startCursor);
    try {
        const [entities, info] = await datastore.runQuery(query);
        entities.forEach((entity) => entity.id = entity[Datastore.KEY].id);
        return [entities, info.endCursor, await getCounterValue(kind)];
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
        const kind = entity[Datastore.KEY]["kind"];
        await datastore.delete(entity[Datastore.KEY]);
        await addCounter(kind, -1);
        return true;
    } catch (err) {
        return handleError(err);
    }
}

async function createCounters() {
    const counters = [
        {
            key: datastore.key(["Counter", "Boat"]),
            data: {
                "count": 0
            }
        },
        {
            key: datastore.key(["Counter", "Load"]),
            data: {
                "count": 0
            }
        }
    ];
    const query = datastore.createQuery("Counter");
    const [listOfCounters] = await datastore.runQuery(query);
    if (! listOfCounters.length) {
        await datastore.save(counters);
    }
}


async function getCounter(kind) {
    const counterKey = datastore.key(["Counter", kind]);
    const transaction = datastore.transaction();
    try {
        await transaction.run();
        let [counter] = await transaction.get(counterKey);
        return [counter, transaction]
    } catch (err) {
        console.log("error in getCounter");
        await transaction.rollback();
        return handleError(err);
    }
}

async function getCounterValue(kind) {
    try {
        const [counter, transaction] = await getCounter(kind);
        await transaction.rollback();
        return counter.count;
    } catch (err) {
        await transaction.rollback();
        return handleError(err);
    }
}

async function addCounter(kind, valueToAdd) {
    const [counter, transaction] = await getCounter(kind);
    try {
        counter.count += valueToAdd;
        transaction.save({key: datastore.key(["Counter", kind]), data: counter});
        await transaction.commit();
    } catch (err) {
        console.log("error in addCounter");
        await transaction.rollback();
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
    createCounters,
};