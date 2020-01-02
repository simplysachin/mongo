// Confirms basic killOperations execution via mongod and mongos.
// @tags: [requires_replication, requires_sharding]

(function() {
"use strict";

const kDbName = "kill_operations";
const kCollName = "test";

const kOpKey1 = "57710eee-37cf-4c68-a3ac-0b0b900c15d2";
const kOpKey2 = "488f6050-e331-4483-b356-230a41ec477e";
const kOpKey3 = "c3eb12fc-4638-4464-8f51-312724ad1710";

const st = new ShardingTest({shards: 1, rs: {nodes: 1}, mongos: 1});
const shardConn = st.rs0.getPrimary();

function blockFinds() {
    assert.commandWorked(shardConn.adminCommand({
        setParameter: 1,
        internalQueryExecYieldIterations: 1,
    }));
    assert.commandWorked(shardConn.adminCommand({
        configureFailPoint: "setYieldAllLocksHang",
        mode: "alwaysOn",
        data: {
            shouldCheckForInterrupt: true,
            nss: kDbName + "." + kCollName,
        },
    }));
}

function unblockFinds() {
    assert.commandWorked(shardConn.adminCommand({
        setParameter: 1,
        internalQueryExecYieldIterations: 0,
    }));
    assert.commandWorked(shardConn.adminCommand({
        configureFailPoint: "setYieldAllLocksHang",
        mode: "off",
    }));
}

function checkForOpKey(conn, opKey) {
    const uuidOpKey = UUID(opKey);

    const ret =
        conn.getDB("admin")
            .aggregate([{$currentOp: {localOps: true}}, {$match: {operationKey: uuidOpKey}}])
            .toArray();

    jsTestLog(`Checked currentOp for opKey ${uuidOpKey}: ${tojson(ret)}`);

    if (ret.length == 0) {
        return false;
    }

    if (ret.every(op => op.killPending)) {
        // CurrentOp actually blocks kills from proceeding.
        return false;
    }

    return true;
}

function killOpKey(conn, opKeys) {
    const uuidOpKeys = opKeys.map((strKey) => UUID(strKey));
    assert.commandWorked(conn.getDB("admin").runCommand({
        _killOperations: 1,
        operationKeys: uuidOpKeys,
    }));
    sleep(1000);
}

function threadRoutine({connStr, dbName, collName, opKey}) {
    var client = new Mongo(connStr);

    const uuidOpKey = UUID(opKey);
    jsTestLog(`Launching find at "${connStr}" with clientOpKey: ${tojson(uuidOpKey)}`);
    const ret = client.getDB(dbName).runCommand({
        find: collName,
        filter: {x: 1},
        limit: 1,
        clientOperationKey: uuidOpKey,
    });
    assert.commandFailed(ret);
}

function runTest(conn) {
    const db = conn.getDB(kDbName);
    assert.commandWorked(db.dropDatabase());
    assert.commandWorked(db.getCollection(kCollName).insert({x: 1}));

    // Kill one missing opKey
    killOpKey(conn, [kOpKey1]);

    // Kill multiple missing opKeys
    killOpKey(conn, [kOpKey1, kOpKey2, kOpKey3]);

    try {
        blockFinds();

        // Start three finds
        let threads = [];
        [kOpKey1, kOpKey2, kOpKey3].forEach(key => {
            let thread =
                new Thread(threadRoutine,
                           {connStr: conn.host, dbName: kDbName, collName: kCollName, opKey: key});

            thread.start();

            assert.soon(function() {
                return checkForOpKey(conn, key);
            }, "Timed out waiting for blocked find", 10000);

            threads.push(thread);
        });

        // Kill the first thread and check the other two
        killOpKey(conn, [kOpKey1]);

        assert.soon(function() {
            return !checkForOpKey(conn, kOpKey1);
        }, "Timed out waiting for killed find", 10000);

        assert(checkForOpKey(conn, kOpKey2));
        assert(checkForOpKey(conn, kOpKey3));

        // Kill all three (including the already dead one)
        killOpKey(conn, [kOpKey1, kOpKey2, kOpKey3]);

        assert.soon(function() {
            return !checkForOpKey(conn, kOpKey2) && !checkForOpKey(conn, kOpKey3);
        }, "Timed out waiting for killed find", 10000);

        unblockFinds();

        threads.forEach(thread => {
            thread.join();
        });
    } finally {
        unblockFinds();
    }
}

// Test killOp against mongod.
runTest(shardConn);

// Test killOp against mongos.
runTest(st.s);

st.stop();
})();
