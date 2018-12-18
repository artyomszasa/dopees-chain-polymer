import { Executor } from 'dopees-chain';
export interface Options {
    sourceRoot: string;
    targetRoot: string;
    buildRoot?: string;
    cwd?: string;
}
export declare class PolymerProject {
    sourceRoot: string;
    targetRoot: string;
    buildRoot: string;
    cwd: string;
    taskName: string;
    constructor(config: Options);
    private getTargets;
    createExecutor(): Executor;
}
