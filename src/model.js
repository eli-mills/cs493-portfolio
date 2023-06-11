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
        this.validationResults = {
            missingProps: false,
            failedRules: {}
        };
    }

    getEntityData() {
        throw Error("This method is not implemented in parent and should be overridden.")
    }

    getEntityKey(kind) {
        throw Error("This method is not implemented in parent and should be overridden.")
    }

    propsAreMissing() {
        if (Object.values(this).reduce((acc, cur)=>acc || cur === undefined, false)) {
            this.validationResults.missingProps = true;
            return true;
        };

        return false;
    }

    propFailsValidationRules() {
        for (const [prop, rules] of Object.entries(this.validation)) {
            let i = 0;
            for (const rule of rules) {
                if (!rule(this[prop])) {
                    this.validationResults.failedRules[prop] = i;
                    return true;
                }
                i++;
            }
        }
        return false;
    }

    instanceIsInvalid() {
        return this.propsAreMissing() || this.propFailsValidationRules();
    }
    
    validateInstance() {
        if (this.instanceIsInvalid()) {
            throw new EntityValidationError(
                `${this.constructor.name} instance failed to validate. 
                properties: ${JSON.stringify(this.getEntityData())} 
                validationResults: ${JSON.stringify(this.validationResults)}`);
        }
    }
}

/**
 * Defines data structure to use when creating a new boat.
 */
class Boat extends Entity{
    static EDITABLE_PROPS = ["name", "type", "length"];
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
    static EDITABLE_PROPS = ["volume", "item", "creation_date"];
    constructor({volume, item, creation_date, user, carrier=null}) {
        super();
        this.volume = volume;
        this.item = item;
        this.creation_date = creation_date;
        this.user = user;
        this.carrier = carrier;
        this.validation = {
            volume: [
                vol => vol >= 1 && vol <= 9999,
                vol => Number.isInteger(vol),
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
        return {
            volume: this.volume, 
            item: this.item, 
            creation_date: this.creation_date, 
            user: this.user,
            carrier: this.carrier
        }
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
 *                       UTILITY FUNCTIONS                      *
 *                                                              *
 ****************************************************************/

function handleError(err) {
    console.error(err);
    return false;
}

/****************************************************************
 *                                                              *
 *                           COUNTERS                           *
 *                                                              *
 ****************************************************************/

async function createCounters() {
    const counters = [
        {
            key: datastore.key(["Counter", "Boat"]),
            data: {
                "total": 0
            }
        },
        {
            key: datastore.key(["Counter", "Load"]),
            data: {
                "total": 0
            }
        },
        {
            key: datastore.key(["Counter", "User"]),
            data: {
                "total": 0
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

async function getCounterValue(kind, user) {
    try {
        const [counter, transaction] = await getCounter(kind);
        await transaction.rollback();
        return counter[user] || counter.total;
    } catch (err) {
        await transaction.rollback();
        return handleError(err);
    }
}

async function addCounter(kind, user, valueToAdd) {
    const [counter, transaction] = await getCounter(kind);
    try {
        counter.total = Math.max(0, counter.total + valueToAdd);
        if (user) {
            const userCount = counter[user] || 0;
            counter[user] = Math.max(0, userCount + valueToAdd);
        }
        transaction.save({key: datastore.key(["Counter", kind]), data: counter});
        await transaction.commit();
    } catch (err) {
        console.log("error in addCounter");
        await transaction.rollback();
        return handleError(err);
    }
}

/****************************************************************
 *                                                              *
 *                    DATA MODEL FUNCTIONS                      *
 *                                                              *
 ****************************************************************/

function createEntityInstance(kind, entityData) {
    const newInstance = {
        "Boat": () => {return new Boat(entityData)},
        "Load": () => {return new Load(entityData)},
        "User": () => {return new User(entityData)},
    }[kind]();
    return newInstance;
}

/**
 * Adds a new entity to the database.
 * 
 * @param {object} Object containing all entity properties
 * 
 * @returns new entity, or false if error.
 */
async function storeNewEntity(kind, entityData) {
    const newInstance = createEntityInstance(kind, entityData);
    const newEntity = {
        key: newInstance.getEntityKey(kind),
        data: newInstance.getEntityData()
    }
    try {
        await datastore.save(newEntity);
        await addCounter(kind, newEntity.data.user, 1);
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
async function getAllEntities(kind, user=undefined, startCursor=undefined) {
    let query = datastore.createQuery(kind).limit(PAGE_SIZE);
    if (user) {
        propFilter = new PropertyFilter("user", "=", user);
        query = query.filter(propFilter);
    }
    if (startCursor) query = query.start(startCursor);
    try {
        const [entities, info] = await datastore.runQuery(query);
        entities.forEach((entity) => entity.id = entity[Datastore.KEY].id);
        const endCursor = info.moreResults === Datastore.NO_MORE_RESULTS
                          ? undefined 
                          : info.endCursor;
        return [entities, endCursor, await getCounterValue(kind, user)];
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
async function updateEntity(entity, modifications) {
    const kind = entity[Datastore.KEY]["kind"];
    Object.keys(entity).forEach(prop => prop in modifications && (entity[prop] = modifications[prop]));
    delete entity.id;   // Remove id property generated from getEntity
    
    // Validate data
    createEntityInstance(kind, entity);
    console.log(JSON.stringify(entity));
    try {
        await datastore.save(entity);
        return await getEntity(kind, entity[Datastore.KEY].id);
    } catch (err) {
        return handleError(err);
    }
}

async function replaceEntity(entity, replacementData) {
    const kind = entity[Datastore.KEY].kind;
    const replacementEntity = createEntityInstance(kind, replacementData);
    Object.assign(entity, replacementEntity.getEntityData());
    try {
        await datastore.save(entity);
        return await getEntity(kind, entity[Datastore.KEY].id);
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
        await addCounter(kind, entity.user, -1);
        return true;
    } catch (err) {
        return handleError(err);
    }
}

module.exports = {
    getEntity,
    storeNewEntity,
    getAllEntities,
    updateEntity,
    replaceEntity,
    deleteEntity,
    EntityValidationError,
    createCounters,
};