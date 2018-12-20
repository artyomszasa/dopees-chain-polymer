import { Executor } from 'dopees-chain';
export interface Options {
    sourceRoot: string;
    targetRoot: string;
    buildRoot?: string;
    cwd?: string;
    /** When _true_ all deep dependencies are rewritten with respoct to the target directory. */
    application?: boolean;
}
export declare class PolymerProject {
    sourceRoot: string;
    targetRoot: string;
    buildRoot: string;
    cwd: string;
    application: boolean;
    taskName: string;
    constructor(config: Options);
    private getTargets;
    createExecutor(): Executor;
}
