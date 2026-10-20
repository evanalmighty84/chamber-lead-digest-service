#!/usr/bin/env node

"use strict";

const path = require("path");
const { spawn } = require("child_process");

function envFlag(name, fallback = true) {
    const raw = process.env[name];

    if (raw === undefined || raw === null || String(raw).trim() === "") {
        return fallback;
    }

    return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function runScript(fileName, label) {
    return new Promise((resolve) => {
        const scriptPath = path.join(__dirname, fileName);

        console.log("");
        console.log("============================================================");
        console.log(`[chamber-runner] Starting ${label}`);
        console.log(`[chamber-runner] Script: ${scriptPath}`);
        console.log("============================================================");

        const child = spawn(
            process.execPath,
            [scriptPath],
            {
                cwd: __dirname,
                env: process.env,
                stdio: "inherit",
            },
        );

        child.once("error", (error) => {
            console.error(
                `[chamber-runner] Could not start ${label}:`,
                error,
            );

            resolve({
                success: false,
                code: null,
                signal: null,
                error,
            });
        });

        child.once("exit", (code, signal) => {
            if (signal) {
                console.error(
                    `[chamber-runner] ${label} stopped by ${signal}.`,
                );

                resolve({
                    success: false,
                    code,
                    signal,
                    error: null,
                });

                return;
            }

            if (code !== 0) {
                console.error(
                    `[chamber-runner] ${label} exited with code ${code}.`,
                );

                resolve({
                    success: false,
                    code,
                    signal: null,
                    error: null,
                });

                return;
            }

            console.log(
                `[chamber-runner] ${label} completed successfully.`,
            );

            resolve({
                success: true,
                code: 0,
                signal: null,
                error: null,
            });
        });
    });
}

async function main() {
    console.log(
        `[chamber-runner] Daily Chamber job started at ` +
        `${new Date().toISOString()}`,
    );

    const results = [];

    if (envFlag("CHAMBER_RUN_CLASSIFY_FIRST", true)) {
        results.push(
            await runScript(
                "chamber_classify.js",
                "Chamber classification",
            ),
        );
    } else {
        console.log(
            "[chamber-runner] CHAMBER_RUN_CLASSIFY_FIRST is off; " +
            "skipping classification.",
        );
    }

    /*
     * Run the digest even if classification failed.
     *
     * Existing already-classified recipients can still receive their digest,
     * while the failed classification rows remain available for a later retry.
     */
    results.push(
        await runScript(
            "chamber_lead_digest.js",
            "Chamber lead digest",
        ),
    );

    const failures =
        results.filter((result) => result.success !== true);

    console.log("");
    console.log(
        `[chamber-runner] Finished at ${new Date().toISOString()}. ` +
        `failures=${failures.length}`,
    );

    if (failures.length) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(
        "[chamber-runner] Fatal runner error:",
        error,
    );

    process.exitCode = 1;
});
