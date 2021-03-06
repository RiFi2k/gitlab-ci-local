import * as c from "ansi-colors";
import * as fs from "fs-extra";
import * as yaml from "js-yaml";
import * as yargs from "yargs";

import { Job } from "./job";
import { Parser } from "./parser";

// Array polyfill
declare global {
    // tslint:disable-next-line:interface-name
    interface Array<T> {
        first(): T | undefined;
        last(): T | undefined;
    }
}
Array.prototype.last = function() {
    return this[this.length - 1];
};
Array.prototype.first = function() {
    return this[0];
};

yargs
    .alias("v", "version")
    .version("3.0.7")
    .command("exec [name]", "Run a single job")
    .command("manual [names..]", "Run manual jobs during the pipeline")
    .command("list", "List all jobs, with detailed info")
    .options("cwd", {type: "string", description: "Path to a gitlab-ci.yml", requiresArg: true});

const argv: any = yargs.argv;
const cwd = String(argv.cwd || process.cwd());
const manualArgs: string[] = [].concat(argv.names || []);

const firstArg = argv._[0] ? argv._[0] : "pipeline";
const parser = new Parser(cwd);

const runJobs = async () => {
    const jobs = Array.from(parser.getJobs().values());
    const stages = Array.from(parser.getStages().values());

    let stage = stages.shift();
    while (stage !== undefined) {
        const jobsInStage = stage.getJobs();
        const stageName = stage.name;

        if (!stage.isRunning()) {
            process.stdout.write(`=> ${c.yellow(`${stageName}`)} <=\n`);
            if (jobsInStage.length === 0 && !stage.isRunning()) {
                process.stdout.write(`=> ${c.yellow(`${stageName}`)} has no jobs\n`);
            }
        }

        for (const job of jobsInStage) {
            if (job.isManual() && !manualArgs.includes(job.name) && !job.isFinished()) {
                process.stdout.write(`${job.getJobNameString()} ${c.magentaBright("skipped")} when:manual\n`);
                job.setFinished(true);
                continue;
            }

            if (job.isNever() && !job.isFinished()) {
                process.stdout.write(`${job.getJobNameString()} ${c.magentaBright("skipped")} when:never\n`);
                job.setFinished(true);
                continue;
            }

            if (!job.isRunning() && !job.isFinished()) {
                /* tslint:disable */
                // noinspection ES6MissingAwait
                job.start();
                /* tslint:enabled */
            }
        }

        // Find jobs that can be started, because their needed jobs have finished
        for (const job of jobs) {
            if (job.isRunning() || job.isFinished() || job.needs === null) {
                continue;
            }

            const finishedJobNames = jobs.filter((e) => e.isFinished()).map((j) => j.name);
            const needsConditionMet = job.needs.every((v) => (finishedJobNames.indexOf(v) >= 0));
            if (needsConditionMet) {
                /* tslint:disable */
                // noinspection ES6MissingAwait
                job.start();
                /* tslint:enabled */
            }
        }

        await new Promise((r) => setTimeout(r, 50));

        if (stage.isFinished()) {
            if (!stage.isSuccess()) {
                printReport(jobs);
                process.exit(2);
            }
            stage = stages.shift();
        }
    }

    printReport(jobs);

};

const printReport = (jobs: Job[]) => {
    process.stdout.write(`\n<<<<< ------- ${c.magenta('report')} ------- >>>>>\n`);

    const stageNames = Array.from(parser.getStages().values()).map((s) => s.name);
    jobs.sort((a, b) => {
        const whenPrio = ["never"];
        if (a.stage !== b.stage) {
            return stageNames.indexOf(a.stage) - stageNames.indexOf(b.stage);
        }
        return whenPrio.indexOf(b.when) - whenPrio.indexOf(a.when);
    });

    for (const job of jobs) {
        if (!job.isStarted()) {
            process.stdout.write(`${job.getJobNameString()} not started\n`);
        } else if (job.getPrescriptsExitCode() === 0) {
            process.stdout.write(`${job.getJobNameString()} ${c.green('successful')}\n`);
        } else if (job.allowFailure) {
            process.stdout.write(`${job.getJobNameString()} ${c.yellowBright(`warning with code ${job.getPrescriptsExitCode()}`)}\n`);
        } else {
            process.stdout.write(`${job.getJobNameString()} ${c.red(`exited with code ${job.getPrescriptsExitCode()}`)}\n`);
        }
    }
};

const runExecJobs = async () => {
    const jobs = [];
    const jobName: string = String(argv.name);
    const job = parser.getJobs().get(jobName);
    if (!job) {
        process.stderr.write(`${c.blueBright(`${jobName}`)} ${c.red(" could not be found")}\n`);
        process.exit(1);
    }

    jobs.push(job);

    /* tslint:disable */
    // noinspection ES6MissingAwait
    job.start();
    /* tslint:enabled */


    while (jobs.filter((j) => j.isRunning()).length > 0) {
        await new Promise((r) => setTimeout(r, 50));
    }

    if (jobs.filter((j) => j.isSuccess()).length !== jobs.length) {
        printReport(jobs);
        process.exit(2);
    }
    printReport(jobs);
};

const listJobs = () => {
    const stageNames = Array.from(parser.getStages().values()).map((s) => s.name);
    const jobs = Array.from(parser.getJobs().values()).sort((a, b) => {
        const whenPrio = ["never"];
        if (a.stage !== b.stage) {
            return stageNames.indexOf(a.stage) - stageNames.indexOf(b.stage);
        }
        return whenPrio.indexOf(b.when) - whenPrio.indexOf(a.when);
    });

    const header = `${"Name".padEnd(parser.maxJobNameLength)}  ${"When".padEnd(20)} ${"Stage".padEnd(15)} ${"AllowFailure".padEnd(15)} ${"Needs"}`;
    process.stdout.write(`${header}\n`);
    process.stdout.write(`${new Array(header.length).fill("-").join("")}\n`);

    for (const job of jobs) {
        const needs = job.needs;
        let jobLine = `${job.getJobNameString()} ${job.when.padEnd(20)} ${c.yellow(`${job.stage.padEnd(15)}`)} ${String(job.allowFailure).padEnd(15)}`;
        if (needs) {
            jobLine += ` needs: [${c.blueBright(`${needs.join(',')}`)}]`
        }
        process.stdout.write(`${jobLine}\n`);
    }
};

process.on("uncaughtException", (err) => {
    // Handle the error safely
    process.stderr.write(`${err}\n`);
    process.exit(5);
});

// Ensure gitlab-ci-local working directory and assets.
const pipelinesStatePath = `${cwd}/.gitlab-ci-local/state.yml`;
fs.ensureFileSync(pipelinesStatePath);
let pipelinesState: any = yaml.safeLoad(fs.readFileSync(pipelinesStatePath, "utf8"));
if (!pipelinesState) {
    pipelinesState = {};
}
pipelinesState.pipelineId = pipelinesState.pipelineId !== undefined ? Number(pipelinesState.pipelineId) : 0;
if (["pipeline", "manual"].includes(firstArg)) {
    pipelinesState.pipelineId += 1;
}
fs.writeFileSync(pipelinesStatePath, yaml.safeDump(pipelinesState), {});
process.env.CI_PIPELINE_ID = pipelinesState.pipelineId;

if (["pipeline", "manual"].includes(firstArg)) {
    // noinspection JSIgnoredPromiseFromCall
    runJobs();
} else if (firstArg === "exec") {
    // noinspection JSIgnoredPromiseFromCall
    runExecJobs();
} else if (firstArg === "list") {
    listJobs();
} else {
    process.stderr.write("You must specify 'nothing', exec, manual or pipeline as 1st argument\n");
    process.exit(1);
}
