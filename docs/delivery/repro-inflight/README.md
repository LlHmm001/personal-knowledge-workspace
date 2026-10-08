# Lifecycle drain: the explicit-signal work, its evidence and its open questions

This directory holds the reproduction and the logs for the two questions the review asked to settle
before the lifecycle tests may be called deterministic. Nothing here is part of the product; it is
the evidence behind `scripts/tests/inflight-signal.test.mjs` and the reason one lifecycle test still
uses a fixed sleep.

## The test-only observation gate

`scripts/serve-collaboration.mjs` carries a gate that is inert unless `PKW_TEST_GATE_FILE` names a
JSON configuration:

```json
{ "path": "/pkw/spaces/<id>/api", "method": "POST", "holdCount": 5, "holdMs": 0,
  "log": "<dir>/gate.log", "release": "<dir>/gate.release" }
```

The gate numbers the requests matching `path`+`method`, records `entered` when the chosen ordinal
arrives, waits for the release file (and for `holdMs`), then records `released` and passes the
request to the product **untouched**. Because the request is an ordinary request counted by the
service's own in-flight registration, holding it does not bypass the service's accounting: the
drain has to finish it.

`holdCount` names the request by position, so a test never guesses how many requests preceded the
one it cares about. `holdMs` sets how long it is held; zero means "report but do not hold".

## What the reproduction shows (`repro.mjs`)

```
node repro.mjs --target DIR --mode parked --hold-ms 250 --stub-delay 1500 --port N
```

Stages recorded, each with a timestamp: `copy`, `listening`, `login`, `session`, `createNote`,
`getNote`, `control-save`, `getNote-before-flight`, `write-entered`, `signal`, `response-ended`,
`stopped`, `indexed`, `restart-read`, `restart-stopped`, `stub`.

Results (sanitized logs in `stages-parked.json` and `explicit-signal-*.log`):

| run | hold | stub latency | response | stop | restart read |
|---|---|---|---|---|---|
| parked ×1 | 250 ms | 0 | 200 committed | exit 0 graceful | 200, revision 3, both markers |
| parked ×6 | 250 ms | 0 | 200 committed | exit 0 graceful | 200, revision 3, both markers |
| parked ×8 | 150 ms | 1500 ms | 200 committed | exit 0 graceful | 200, revision 3, both markers |

So, for the sequence *hold a request → SIGTERM → release → restart*: the response is delivered, the
commit is durable, the index carries the new revision, the writer exits 0 through the graceful path,
and a fresh process reads the committed content back. The `ECONNRESET`/"other side closed" seen
during the investigation was produced by earlier, faulty test scaffolding — a gate that released
immediately because the release file already existed, plus a helper that read an empty gate log
before the request had been recorded, which tore the connection down from the client side. It is not
reproducible with the gate as it now stands.

## The new deterministic test

`scripts/tests/inflight-signal.test.mjs` (10th lifecycle test, 0 skip with the fixture in place)
asserts the whole chain, with the two halves of the data checked separately:

request accepted → business write entered → commit done (HTTP 200 + indexed revision) → response
finished → SIGTERM while `released` is still absent → release → graceful exit 0 → restart read-back
containing **both** the write committed before the signal and the write that was in flight across it.

It also asserts, before the signal, that the in-flight write's own promise has not settled — so a
run that finished the write too early fails instead of passing by luck.

## Open question: the original lifecycle write test

The same signals could not be made to pass inside
`S3/T-EXIT graceful shutdown with a request in flight commits data and exits 0`. With the gate
added (and with the earlier diagnostic instrumentation) that test returns `400 PKW_REQUEST_FAILED`
from its **restart** read-back, reproducibly; the standalone test and the reproduction pass the
identical sequence. The difference between the two has not been isolated, so the test keeps its
fixed sleep and all nine original lifecycle tests pass. This is reported as an open item rather than
papered over: a fixed sleep still decides "in flight" there.

Two candidate causes were ruled out by measurement, not by assumption:

* test-hang mechanics — the gate releases on a signal and the product's in-flight registration is
  not bypassed;
* HTTP connection closure — the reproduction shows the response arriving after the signal, with the
  writer exiting 0.

That leaves a business-persistence difference specific to that test's setup, which is where the next
investigation should start.

## Commands

```
# the reproduction, kept directory and stages
node docs/delivery/repro-inflight/repro.mjs --target /tmp/pkw-repro/x --mode parked \
  --hold-ms 250 --stub-delay 1500 --port 43111 --keep

# the deterministic lifecycle test (needs the fixture)
PKW_TEST_PROFILE=<profile> PKW_TEST_DATA_ROOT=<fixture> PKW_TEST_USERNAME=owner \
  node --test scripts/tests/inflight-signal.test.mjs

# the whole lifecycle set, 0 skip
PKW_TEST_PROFILE=<profile> PKW_TEST_DATA_ROOT=<fixture> PKW_TEST_USERNAME=owner \
  node --test scripts/tests/pkw-shutdown.test.mjs scripts/tests/inflight-signal.test.mjs
```
