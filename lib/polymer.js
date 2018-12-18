"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fspath = require("path");
const fs = require("fs");
const dopees_chain_1 = require("dopees-chain");
const dopees_chain_sass_1 = require("dopees-chain-sass");
const dopees_chain_pug_1 = require("dopees-chain-pug");
const dopees_chain_typescript_1 = require("dopees-chain-typescript");
const babel = require("@babel/core");
const traverse_1 = require("@babel/traverse");
const mkdirp = require("mkdirp");
const mkdirrec = (path) => new Promise((resolve, reject) => mkdirp(path, (err, res) => err ? reject(err) : resolve(res)));
const fsp = fs.promises;
const fsmtime = (path) => fsp.stat(path).then(stats => stats.mtime, () => null);
const toAbsolutePath = (path, base) => {
    if (fspath.isAbsolute(path)) {
        return fspath.normalize(path);
    }
    return fspath.normalize(fspath.join(base, path));
};
const findAllDependencies = (ast, action) => {
    return traverse_1.default(ast, {
        ImportDeclaration(path) {
            const node = path.node;
            action(node.source.value);
        },
        ExportDeclaration(path) {
            const node = path.node;
            if ('ExportNamedDeclaration' === node.type) {
                const n = node;
                if (n.source) {
                    action(n.source.value);
                }
            }
        }
    });
};
async function resolveDeep(targetRoot, npmRoot, context, toCopy, path) {
    const mtime = await fsmtime(path);
    if (!mtime) {
        throw new Error(`failed to get mtime for ${path}`);
    }
    let deps;
    const entry = await context.storage.getObject(`!polymer.deep.depepndencies!${path}`);
    if (entry && entry.mtime >= mtime) {
        deps = entry.deps;
    }
    else {
        // already parsed?
        let ast;
        const entry = await context.storage.getObject(`!polymer.deep.ast!${path}`);
        if (entry && entry.mtime >= mtime) {
            ast = entry.ast;
        }
        else {
            const babelOptions = {
                filename: path,
                ast: true,
                root: npmRoot,
                rootMode: 'root',
                parserOpts: {
                    sourceType: 'module'
                }
            };
            const sourceCode = await context.getContents(dopees_chain_1.Task.file(path), 'utf-8');
            ast = await babel.parseAsync(sourceCode, babelOptions);
            await context.storage.setObject(`!polymer.deep.ast!${path}`, { mtime, ast });
        }
        // get dependencies
        deps = [];
        findAllDependencies(ast, dep => deps.push(dep));
        await context.storage.setObject(`!polymer.deep.depepndencies!${path}`, { mtime, deps });
    }
    // process dependencies
    const deepDependencies = [];
    for (const localPath of deps) {
        if (localPath.startsWith('./') || localPath.startsWith('../')) {
            // in-package dependency
            let source = fspath.normalize(fspath.join(fspath.dirname(path), localPath));
            if (!source.endsWith('.js')) {
                source += '.js';
            }
            if (!toCopy.some(e => e.source === source)) {
                const target = fspath.normalize(fspath.join(targetRoot, fspath.relative(npmRoot, source)));
                toCopy.push({ source, target });
                deepDependencies.push(source);
            }
        }
        else {
            // external dependency
            let source = fspath.normalize(fspath.join(npmRoot, localPath));
            if (!source.endsWith('.js')) {
                source += '.js';
            }
            if (!toCopy.some(e => e.source === source)) {
                const target = fspath.normalize(fspath.join(targetRoot, fspath.relative(npmRoot, source)));
                toCopy.push({ source, target });
                deepDependencies.push(source);
            }
        }
    }
    // trigger deep resolve
    await Promise.all(deepDependencies.map(path => resolveDeep(targetRoot, npmRoot, context, toCopy, path)));
}
function unique(source) {
    const result = [];
    for (const item of source) {
        if (!result.some(i => i === item)) {
            result.push(item);
        }
    }
    return result;
}
function deploy(opts) {
    const { targetRoot, buildTaskName, allDependenciesKey } = opts;
    return async (task, context) => {
        if (task.name instanceof dopees_chain_1.LogicalName && task.name.name === buildTaskName) {
            const deps = await context.storage.getObject(allDependenciesKey);
            if (!deps) {
                throw new Error('no dependencies has been populated');
            }
            const root = context.basePath;
            const npmRoot = fspath.join(root, 'node_modules');
            // flatten dependencies
            const toCopy = [];
            // const imports: Array<{ name: string, target: string }> = [];
            context.log('deploy', task, 'resolving source dependencies...');
            const allSources = unique(deps.map(dep => dep.source));
            for (const entry of deps) {
                for (const dep of entry.dependencies) {
                    const possibleSource = fspath.normalize(fspath.join(fspath.dirname(entry.source), dep));
                    if (!allSources.some(x => x === possibleSource)) {
                        const dependency = fspath.relative(targetRoot, possibleSource);
                        let mtime;
                        // try js in modules
                        let candidate = fspath.join(npmRoot, dependency);
                        mtime = await fsmtime(candidate);
                        if (!mtime) {
                            throw new Error(`unable to resolve ${dependency}`);
                        }
                        const target = fspath.join(targetRoot, dependency);
                        toCopy.push({
                            source: candidate,
                            target
                        });
                    }
                }
            }
            // context.log('deploy', task, 'done updating dependency imports');
            context.log('deploy', task, 'done resolving source dependencies');
            // resolve deep dependencies
            context.log('deploy', task, 'resolving deep dependencies...');
            await Promise.all(toCopy.map(e => resolveDeep(targetRoot, npmRoot, context, toCopy, e.source)));
            context.log('deploy', task, 'done resolving deep dependencies');
            // copy dependencies
            context.log('deploy', task, 'copying dependencies...');
            const created = new Set();
            await Promise.all(toCopy.map(async (e) => {
                const folder = fspath.dirname(e.target);
                if (!created.has(folder)) {
                    await mkdirrec(folder);
                    created.add(folder);
                }
                await fsp.copyFile(e.source, e.target);
            }));
            context.log('deploy', task, 'done copying dependencies');
        }
    };
}
class PolymerProject {
    constructor(config) {
        this.taskName = 'dopees-polymer';
        this.cwd = config.cwd || process.cwd();
        this.buildRoot = toAbsolutePath(config.buildRoot || './.build', this.cwd);
        this.sourceRoot = toAbsolutePath(config.sourceRoot, this.cwd);
        this.targetRoot = toAbsolutePath(config.targetRoot, this.cwd);
    }
    async getTargets() {
        const targets = [];
        const traverse = async (subpath) => {
            const names = await fsp.readdir(fspath.join(this.sourceRoot, subpath));
            for (const name of names) {
                const sourcePath = fspath.normalize(fspath.join(this.sourceRoot, subpath, name));
                const stats = await fsp.stat(sourcePath).catch(() => null);
                if (stats) {
                    if (stats.isDirectory()) {
                        await traverse(fspath.normalize(fspath.join(subpath, name)));
                    }
                    else if (sourcePath.endsWith('.ts') && !sourcePath.endsWith('.d.ts')) {
                        const targetPath = fspath.normalize(fspath.join(this.targetRoot, fspath.relative(this.sourceRoot, sourcePath))).replace(/\.ts$/, '.js');
                        targets.push({ path: targetPath, base: this.cwd });
                    }
                }
            }
        };
        await traverse('.');
        return targets;
    }
    createExecutor() {
        const pugSourceResolver = dopees_chain_1.ReversePathResolver.from({
            sourceRoot: fspath.relative(this.cwd, this.sourceRoot),
            targetRoot: fspath.relative(this.cwd, this.buildRoot),
            sourceExt: 'pug',
            targetExt: 'html'
        });
        return dopees_chain_1.Executors.combine([
            dopees_chain_sass_1.sass({
                sourceRoot: fspath.relative(this.cwd, this.sourceRoot),
                targetRoot: fspath.relative(this.cwd, this.buildRoot),
                sourceExt: 'scss',
                targetExt: 'css',
                outputStyle: 'compressed'
            }),
            dopees_chain_pug_1.pug({
                inlineCss: true,
                targetRoot: fspath.relative(this.cwd, this.buildRoot),
                sourceResolver: (path, base) => {
                    const source = pugSourceResolver(path, base);
                    if (!source) {
                        throw new Error(`unable to resolve source for ${path} (base = ${base})`);
                    }
                    return source;
                }
            }),
            dopees_chain_typescript_1.dopees({
                sourceRoot: fspath.relative(this.cwd, this.sourceRoot),
                buildRoot: fspath.relative(this.cwd, this.buildRoot),
                targetRoot: fspath.relative(this.cwd, this.targetRoot),
                saveAllDependencies: true,
                allDependenciesKey: 'dopees.polymer.dependencies',
                updateExternalImports: true
            }),
            async (task, context) => {
                if (task.name instanceof dopees_chain_1.LogicalName && task.name.name === this.taskName) {
                    const targets = await this.getTargets();
                    await Promise.all(targets.map(target => context.execute(dopees_chain_1.Task.file(target.path, target.base))));
                }
            },
            deploy({
                targetRoot: this.targetRoot,
                allDependenciesKey: 'dopees.polymer.dependencies',
                buildTaskName: this.taskName
            })
        ]);
    }
}
exports.PolymerProject = PolymerProject;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicG9seW1lci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9wb2x5bWVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBQUEsK0JBQStCO0FBQy9CLHlCQUF5QjtBQUN6QiwrQ0FBb0c7QUFDcEcseURBQXlDO0FBQ3pDLHVEQUF1QztBQUN2QyxxRUFBa0U7QUFFbEUscUNBQXFDO0FBQ3JDLDhDQUF1QztBQUN2QyxpQ0FBaUM7QUFFakMsTUFBTSxRQUFRLEdBQUcsQ0FBQyxJQUFZLEVBQXdCLEVBQUUsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsQ0FBQyxHQUFHLEVBQUUsR0FBRyxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUV4SixNQUFNLEdBQUcsR0FBRyxFQUFFLENBQUMsUUFBUSxDQUFDO0FBRXhCLE1BQU0sT0FBTyxHQUFHLENBQUMsSUFBWSxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUUsR0FBRyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUM7QUFTeEYsTUFBTSxjQUFjLEdBQUcsQ0FBQyxJQUFZLEVBQUUsSUFBWSxFQUFFLEVBQUU7SUFDcEQsSUFBSSxNQUFNLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxFQUFFO1FBQzNCLE9BQU8sTUFBTSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQztLQUMvQjtJQUNELE9BQU8sTUFBTSxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDO0FBQ25E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