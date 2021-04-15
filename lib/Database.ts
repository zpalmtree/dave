import {
    Database,
    RunResult,
    verbose,
} from 'sqlite3';

import { config } from './Config';

export async function executeQuery(query: string, db: Database, params: any = []): Promise<void> {
    return new Promise((resolve, reject) => {
        const f = function (err: Error | null) {
            if (err) {
                return reject(err);
            }

            return resolve();
        }

        db.run(query, params, f);
    });
}

export async function insertQuery(query: string, db: Database, params: any = []): Promise<number> {
    return new Promise((resolve, reject) => {
        const f = function (this: RunResult, err: Error | null) {
            if (err) {
                return reject(err);
            }

            return resolve(this.lastID);
        }

        db.run(query, params, f);
    });
}

export async function selectQuery(query: string, db: Database, params: any = []): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const f = function (err: Error | null, rows: any[]) {
            if (err) {
                return reject(err);
            }

            return resolve(rows);
        }

        db.all(query, params, f);
    });
}

export async function selectOneQuery<T>(query: string, db: Database, params: any = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
        const f = function (err: Error | null, row: T | undefined) {
            if (err) {
                return reject(err);
            }

            return resolve(row);
        }

        db.get(query, params, f);
    });
}

export async function deleteQuery(query: string, db: Database, params: any = []): Promise<number> {
    return new Promise((resolve, reject) => {
        const f = function (this: RunResult, err: Error | null) {
            if (err) {
                return reject(err);
            }

            return resolve(this.changes);
        }

        db.run(query, params, f);
    });
}

export async function updateQuery(query: string, db: Database, params: any = []): Promise<number> {
    return new Promise((resolve, reject) => {
        const f = function (this: RunResult, err: Error | null) {
            if (err) {
                return reject(err);
            }

            return resolve(this.changes);
        }

        db.run(query, params, f);
    });
}

export async function serializeQueries(callback: () => any, db: Database) {
    return new Promise((resolve, reject) => {
        db.serialize();

        callback()
            .finally(() => {
                db.parallelize();
                resolve();
            });
    });
}

export async function createTablesIfNeeded(db: Database) {
    /* This table stores our quotes. Simple as. */
    await executeQuery(`CREATE TABLE IF NOT EXISTS quote (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quote TEXT NOT NULL,
        channel_id VARCHAR(255) NOT NULL,
        timestamp TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP
    )`, db);

    /* This table stores movie titles. */
    await executeQuery(`CREATE TABLE IF NOT EXISTS movie (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        channel_id VARCHAR(255) NOT NULL
    )`, db);

    /* This table stores download links for movies. It references the movie
     * title */
    await executeQuery(`CREATE TABLE IF NOT EXISTS movie_link (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        link TEXT NOT NULL,
        is_download INTEGER NOT NULL,
        movie_id INTEGER NOT NULL,
        FOREIGN KEY(movie_id) REFERENCES movie(id)
    )`, db);

    /* This table stores a watch "event". This is when a user schedules a time
     * to watch a specific movie. We store the channel to have channel specific
     * watch lists. It references the movies title. */
    await executeQuery(`CREATE TABLE IF NOT EXISTS watch_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TIMESTAMP NOT NULL,
        channel_id VARCHAR(255) NOT NULL,
        movie_id INTEGER NOT NULL,
        FOREIGN KEY(movie_id) REFERENCES movie(id)
    )`, db);

    /* This table stores watch event attendees. It stores the discord user id,
     * and references the watch event. */
    await executeQuery(`CREATE TABLE IF NOT EXISTS user_watch (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id VARCHAR(255) NOT NULL,
        watch_event INTEGER NOT NULL,
        FOREIGN KEY(watch_event) REFERENCES watch_event(id)
    )`, db);

    /* This table stores set timers and their messages if they have one. */
    await executeQuery(`CREATE TABLE IF NOT EXISTS timer (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id VARCHAR(255) NOT NULL,
        channel_id VARCHAR(255) NOT NULL,
        message VARCHAR(2000),
        expire_time TIMESTAMP
    )`, db);

    /* This table stores every time a command is called for statistics and 
     * logging purposes */
    await executeQuery(`CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id VARCHAR(255) NOT NULL,
        channel_id VARCHAR(255) NOT NULL,
        command VARCHAR(255) NOT NULL,
        args VARCHAR(2000),
        timestamp TIMESTAMP NOT NULL
    )`, db);

    await executeQuery(`CREATE TABLE IF NOT EXISTS tank_games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id VARCHAR(255) NOT NULL,
        channel_id VARCHAR(255) NOT NULL,
        coord_x INTEGER NOT NULL,
        coord_y INTEGER NOT NULL,
        hp INTEGER NOT NULL,
        points INTEGER NOT NULL,
        team VARCHAR(255),
        CONSTRAINT channel_player UNIQUE (user_id, channel_id)
    )`, db);

    await executeQuery(`CREATE TABLE IF NOT EXISTS turtle_avatars (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id VARCHAR(255) NOT NULL,
        filepath VARCHAR(255) NOT NULL,
        z_index INTEGER NOT NULL,
        image_type INTEGER NOT NULL
    )`, db);

    await executeQuery(`CREATE TABLE IF NOT EXISTS tank_preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id VARCHAR(255) NOT NULL UNIQUE,
        notifications BOOLEAN NOT NULL DEFAULT 1,
        perk INTEGER NOT NULL
    )`, db);
}

export async function deleteTablesIfNeeded(db: Database) {
    if (config.devEnv) {
        const areYouReallySure = false;

        if (areYouReallySure) {
            await executeQuery(`DROP TABLE IF EXISTS quote`, db);
            await executeQuery(`DROP TABLE IF EXISTS movie`, db);
            await executeQuery(`DROP TABLE IF EXISTS movie_link`, db);
            await executeQuery(`DROP TABLE IF EXISTS watch_event`, db);
            await executeQuery(`DROP TABLE IF EXISTS user_watch`, db);
            await executeQuery(`DROP TABLE IF EXISTS timer`, db);
            await executeQuery(`DROP TABLE IF EXISTS logs`, db);
            await executeQuery(`DROP TABLE IF EXISTS tank_games`, db);
            await executeQuery(`DROP TABLE IF EXISTS turtle_avatars`, db);
        }
    }
}
