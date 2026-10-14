#!/usr/bin/env node
// Runs the web manager test suites against a temporary Vaultwarden server.
//   node run.mjs                 all default suites
//   node run.mjs ui sso          only these suites
//   node run.mjs perf            the (slow) large vault check
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_SUITES = ["interop", "keepass-import", "regressions", "ui", "sso", "sso-groups", "sso-directory"];

if (!process.env.VWM_TESTS_CHILD) {
    // Node only reads NODE_EXTRA_CA_CERTS at startup, so create the certificate first and run the tests in a child process
    const env = await import("./lib/env.mjs");
    const cert = env.makeCert();
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
        stdio: "inherit",
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert, VWM_TESTS_CHILD: "1", VWM_TEST_WORK: env.WORK },
    });
    process.exit(r.status ?? 1);
}

const env = await import("./lib/env.mjs");
const suites = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SUITES;
console.log(`Vaultwarden: ${env.VW_BIN}\nWork dir:    ${env.WORK}`);

const passed = [];
const failed = [];
let main = null;
try {
    for (const name of suites) {
        console.log(`\n===== ${name} =====`);
        try {
            // The SSO suites run their own server with SSO settings
            if (!name.startsWith("sso") && !main) main = await env.startServer({ fresh: true });
            const suite = await import(`./suites/${name}.mjs`);
            await suite.run({ base: main?.base });
            passed.push(name);
        } catch (e) {
            console.error(e);
            failed.push(name);
        }
    }
} finally {
    await env.stopAll();
}

console.log(`\n${passed.length} suite(s) passed: ${passed.join(", ") || "-"}`);
if (failed.length) {
    console.log(`${failed.length} suite(s) FAILED: ${failed.join(", ")}`);
    console.log(`Server logs and screenshots are in ${env.WORK}`);
    process.exit(1);
}
console.log(`Screenshots: ${env.WORK}/screenshots`);
