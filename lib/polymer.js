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
const keyDeepDependencies = 'polymer.deep.depepndencies';
async function resolveDeep(targetRoot, npmRoot, context, toCopy, path) {
    const mtime = await fsmtime(path);
    if (!mtime) {
        throw new Error(`failed to get mtime for ${path}`);
    }
    let deps;
    const entry = await context.storage.getObject(`!${keyDeepDependencies}!${path}`);
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
        await context.storage.setObject(`!${keyDeepDependencies}!${path}`, { mtime, deps });
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
                let target = fspath.normalize(fspath.join(targetRoot, fspath.relative(npmRoot, source)));
                // same folder dependencies must start with './'
                if (!target.startsWith('..')) {
                    target = './' + target;
                }
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
        this.application = config.application !== false;
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
        const executors = [
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
                updateExternalImports: this.application
            }),
            async (task, context) => {
                if (task.name instanceof dopees_chain_1.LogicalName && task.name.name === this.taskName) {
                    const targets = await this.getTargets();
                    await Promise.all(targets.map(target => context.execute(dopees_chain_1.Task.file(target.path, target.base))));
                }
            }
        ];
        if (this.application) {
            executors.push(deploy({
                targetRoot: this.targetRoot,
                allDependenciesKey: 'dopees.polymer.dependencies',
                buildTaskName: this.taskName
            }));
        }
        return dopees_chain_1.Executors.combine(executors);
    }
}
exports.PolymerProject = PolymerProject;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicG9seW1lci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9wb2x5bWVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBQUEsK0JBQStCO0FBQy9CLHlCQUF5QjtBQUN6QiwrQ0FBb0c7QUFDcEcseURBQXlDO0FBQ3pDLHVEQUF1QztBQUN2QyxxRUFBa0U7QUFFbEUscUNBQXFDO0FBQ3JDLDhDQUF1QztBQUN2QyxpQ0FBaUM7QUFFakMsTUFBTSxRQUFRLEdBQUcsQ0FBQyxJQUFZLEVBQXdCLEVBQUUsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsQ0FBQyxHQUFHLEVBQUUsR0FBRyxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUV4SixNQUFNLEdBQUcsR0FBRyxFQUFFLENBQUMsUUFBUSxDQUFDO0FBRXhCLE1BQU0sT0FBTyxHQUFHLENBQUMsSUFBWSxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUUsR0FBRyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUM7QUFXeEYsTUFBTSxjQUFjLEdBQUcsQ0FBQyxJQUFZLEVBQUUsSUFBWSxFQUFFLEVBQUU7SUFDcEQsSUFBSSxNQUFNLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxFQUFFO1FBQzNCLE9BQU8sTUFBTSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQztLQUMvQjtJQUNELE9BQU8sTUFBTSxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDO0FBQ25ELENBQUMsQ0FBQTtBQXVCRCxNQUFNLG1CQUFtQixHQUFHLENBQUMsR0FBVyxFQUFFLE1BQWdDLEVBQUUsRUFBRTtJQUM1RSxPQUFPLGtCQUFRLENBQUMsR0FBRyxFQUFFO1FBQ25CLGlCQUFpQixDQUFDLElBQUk7WUFDcEIsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQztZQUN2QixNQUFNLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUM1QixDQUFDO1FBQ0QsaUJBQWlCLENBQUMsSUFBSTtZQUNwQixNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDO1lBQ3ZCLElBQUksd0JBQXdCLEtBQUssSUFBSSxDQUFDLElBQUksRUFBRTtnQkFDMUMsTUFBTSxDQUFDLEdBQTZCLElBQUksQ0FBQztnQkFDekMsSUFBSSxDQUFDLENBQUMsTUFBTSxFQUFFO29CQUNaLE1BQU0sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO2lCQUN4QjthQUNGO1FBQ0gsQ0FBQztLQUNGLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQztBQUVGLE1BQU0sbUJBQW1CLEdBQUcsNEJBQTRCLENBQUM7QUFFekQsS0FBSyxVQUFVLFdBQVcsQ0FBQyxVQUFrQixFQUFFLE9BQWUsRUFBRSxPQUFnQixFQUFFLE1BQWlELEVBQUUsSUFBWTtJQUMvSSxNQUFNLEtBQUssR0FBRyxNQUFNLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUNsQyxJQUFJLENBQUMsS0FBSyxFQUFFO1FBQ1YsTUFBTSxJQUFJLEtBQUssQ0FBQywyQkFBMkIsSUFBSSxFQUFFLENBQUMsQ0FBQztLQUNwRDtJQUNELElBQUksSUFBYyxDQUFDO0lBQ25CLE1BQU0sS0FBSyxHQUFHLE1BQU0sT0FBTyxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQW1CLElBQUksbUJBQW1CLElBQUksSUFBSSxFQUFFLENBQUMsQ0FBQztJQUNuRyxJQUFJLEtBQUssSUFBSSxLQUFLLENBQUMsS0FBSyxJQUFJLEtBQUssRUFBRTtRQUNqQyxJQUFJLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQztLQUNuQjtTQUFNO1FBQ0wsa0JBQWtCO1FBQ2xCLElBQUksR0FBVyxDQUFDO1FBQ2hCLE1BQU0sS0FBSyxHQUFHLE1BQU0sT0FBTyxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQVkscUJBQXFCLElBQUksRUFBRSxDQUFDLENBQUM7UUFDdEYsSUFBSSxLQUFLLElBQUksS0FBSyxDQUFDLEtBQUssSUFBSSxLQUFLLEVBQUU7WUFDakMsR0FBRyxHQUFHLEtBQUssQ0FBQyxHQUFHLENBQUM7U0FDakI7YUFBTTtZQUNMLE1BQU0sWUFBWSxHQUFtQjtnQkFDbkMsUUFBUSxFQUFFLElBQUk7Z0JBQ2QsR0FBRyxFQUFFLElBQUk7Z0JBQ1QsSUFBSSxFQUFFLE9BQU87Z0JBQ2IsUUFBUSxFQUFFLE1BQU07Z0JBQ2hCLFVBQVUsRUFBRTtvQkFDVixVQUFVLEVBQUUsUUFBUTtpQkFDckI7YUFDRixDQUFDO1lBQ0YsTUFBTSxVQUFVLEdBQUcsTUFBTSxPQUFPLENBQUMsV0FBVyxDQUFDLG1CQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLE9BQU8sQ0FBQyxDQUFDO1lBQ3ZFLEdBQUcsR0FBRyxNQUFNLEtBQUssQ0FBQyxVQUFVLENBQUMsVUFBVSxFQUFFLFlBQVksQ0FBQyxDQUFDO1lBQ3ZELE1BQU0sT0FBTyxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQUMscUJBQXFCLElBQUksRUFBRSxFQUFhLEVBQUUsS0FBSyxFQUFFLEdBQUcsRUFBRSxDQUFDLENBQUM7U0FDekY7UUFDRCxtQkFBbUI7UUFDbkIsSUFBSSxHQUFHLEVBQUUsQ0FBQztRQUNWLG1CQUFtQixDQUFDLEdBQUcsRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztRQUNoRCxNQUFNLE9BQU8sQ0FBQyxPQUFPLENBQUMsU0FBUyxDQUFDLElBQUksbUJBQW1CLElBQUksSUFBSSxFQUFFLEVBQW9CLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7S0FDdkc7SUFDRCx1QkFBdUI7SUFDdkIsTUFBTSxnQkFBZ0IsR0FBYSxFQUFFLENBQUM7SUFDdEMsS0FBSyxNQUFNLFNBQVMsSUFBSSxJQUFJLEVBQUU7UUFDNUIsSUFBSSxTQUFTLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxJQUFJLFNBQVMsQ0FBQyxVQUFVLENBQUMsS0FBSyxDQUFDLEVBQUU7WUFDN0Qsd0JBQXdCO1lBQ3hCLElBQUksTUFBTSxHQUFHLE1BQU0sQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxFQUFFLFNBQVMsQ0FBQyxDQUFDLENBQUM7WUFDNUUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLEVBQUU7Z0JBQzNCLE1BQU0sSUFBSSxLQUFLLENBQUM7YUFDakI7WUFDRCxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxNQUFNLEtBQUssTUFBTSxDQUFDLEVBQUU7Z0JBQzFDLE1BQU0sTUFBTSxHQUFHLE1BQU0sQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxVQUFVLEVBQUUsTUFBTSxDQUFDLFFBQVEsQ0FBQyxPQUFPLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDO2dCQUMzRixNQUFNLENBQUMsSUFBSSxDQUFDLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUM7Z0JBQ2hDLGdCQUFnQixDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQzthQUMvQjtTQUNGO2FBQU07WUFDTCxzQkFBc0I7WUFDdEIsSUFBSSxNQUFNLEdBQUcsTUFBTSxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLE9BQU8sRUFBRSxTQUFTLENBQUMsQ0FBQyxDQUFDO1lBQy9ELElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxFQUFFO2dCQUMzQixNQUFNLElBQUksS0FBSyxDQUFDO2FBQ2pCO1lBQ0QsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxLQUFLLE1BQU0sQ0FBQyxFQUFFO2dCQUMxQyxJQUFJLE1BQU0sR0FBRyxNQUFNLENBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFFLE1BQU0sQ0FBQyxRQUFRLENBQUMsT0FBTyxFQUFFLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDekYsZ0RBQWdEO2dCQUNoRCxJQUFJLENBQUMsTUFBTSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsRUFBRTtvQkFDNUIsTUFBTSxHQUFHLElBQUksR0FBRyxNQUFNLENBQUM7aUJBQ3hCO2dCQUNELE1BQU0sQ0FBQyxJQUFJLENBQUMsRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQztnQkFDaEMsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO2FBQy9CO1NBQ0Y7S0FDRjtJQUNELHVCQUF1QjtJQUN2QixNQUFNLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0JBQWdCLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsV0FBVyxDQUFDLFVBQVUsRUFBRSxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDM0csQ0FBQztBQUVELFNBQVMsTUFBTSxDQUFJLE1BQVc7SUFDNUIsTUFBTSxNQUFNLEdBQVEsRUFBRSxDQUFDO0lBQ3ZCLEtBQUssTUFBTSxJQUFJLElBQUksTUFBTSxFQUFFO1FBQ3pCLElBQUksQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxLQUFLLElBQUksQ0FBQyxFQUFFO1lBQ2pDLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7U0FDbkI7S0FDRjtJQUNELE9BQU8sTUFBTSxDQUFDO0FBQ2hCLENBQUM7QUFFRCxTQUFTLE1BQU0sQ0FBQyxJQUFtQjtJQUNqQyxNQUFNLEVBQUUsVUFBVSxFQUFFLGFBQWEsRUFBRSxrQkFBa0IsRUFBRSxHQUFHLElBQUksQ0FBQztJQUMvRCxPQUFPLEtBQUssRUFBRSxJQUFVLEVBQUUsT0FBZ0IsRUFBRSxFQUFFO1FBQzVDLElBQUksSUFBSSxDQUFDLElBQUksWUFBWSwwQkFBVyxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxLQUFLLGFBQWEsRUFBRTtZQUN4RSxNQUFNLElBQUksR0FBRyxNQUFNLE9BQU8sQ0FBQyxPQUFPLENBQUMsU0FBUyxDQUFvQixrQkFBa0IsQ0FBQyxDQUFDO1lBQ3BGLElBQUksQ0FBQyxJQUFJLEVBQUU7Z0JBQ1QsTUFBTSxJQUFJLEtBQUssQ0FBQyxvQ0FBb0MsQ0FBQyxDQUFDO2FBQ3ZEO1lBQ0QsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLFFBQVEsQ0FBQztZQUM5QixNQUFNLE9BQU8sR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxjQUFjLENBQUMsQ0FBQztZQUNsRCx1QkFBdUI7WUFDdkIsTUFBTSxNQUFNLEdBQThDLEVBQUUsQ0FBQztZQUM3RCwrREFBK0Q7WUFDL0QsT0FBTyxDQUFDLEdBQUcsQ0FBQyxRQUFRLEVBQUUsSUFBSSxFQUFFLGtDQUFrQyxDQUFDLENBQUM7WUFDaEUsTUFBTSxVQUFVLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQztZQUN2RCxLQUFLLE1BQU0sS0FBSyxJQUFJLElBQUksRUFBRTtnQkFDeEIsS0FBSyxNQUFNLEdBQUcsSUFBSSxLQUFLLENBQUMsWUFBWSxFQUFFO29CQUNwQyxNQUFNLGNBQWMsR0FBRyxNQUFNLENBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLEVBQUUsR0FBRyxDQUFDLENBQUMsQ0FBQztvQkFDeEYsSUFBSSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEtBQUssY0FBYyxDQUFDLEVBQUU7d0JBQy9DLE1BQU0sVUFBVSxHQUFHLE1BQU0sQ0FBQyxRQUFRLENBQUMsVUFBVSxFQUFFLGNBQWMsQ0FBQyxDQUFDO3dCQUMvRCxJQUFJLEtBQWlCLENBQUM7d0JBQ3RCLG9CQUFvQjt3QkFDcEIsSUFBSSxTQUFTLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxPQUFPLEVBQUUsVUFBVSxDQUFDLENBQUM7d0JBQ2pELEtBQUssR0FBRyxNQUFNLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FBQzt3QkFDakMsSUFBSSxDQUFDLEtBQUssRUFBRTs0QkFDVixNQUFNLElBQUksS0FBSyxDQUFDLHFCQUFxQixVQUFVLEVBQUUsQ0FBQyxDQUFDO3lCQUNwRDt3QkFDRCxNQUFNLE1BQU0sR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLFVBQVUsRUFBRSxVQUFVLENBQUMsQ0FBQzt3QkFDbkQsTUFBTSxDQUFDLElBQUksQ0FBQzs0QkFDVixNQUFNLEVBQUUsU0FBUzs0QkFDakIsTUFBTTt5QkFDUCxDQUFDLENBQUM7cUJBQ0o7aUJBQ0Y7YUFDRjtZQUNELG1FQUFtRTtZQUNuRSxPQUFPLENBQUMsR0FBRyxDQUFDLFFBQVEsRUFBRSxJQUFJLEVBQUUsb0NBQW9DLENBQUMsQ0FBQztZQUNsRSw0QkFBNEI7WUFDNUIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxRQUFRLEVBQUUsSUFBSSxFQUFFLGdDQUFnQyxDQUFDLENBQUM7WUFDOUQsTUFBTSxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxXQUFXLENBQUMsVUFBVSxFQUFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDaEcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxRQUFRLEVBQUUsSUFBSSxFQUFFLGtDQUFrQyxDQUFDLENBQUM7WUFDaEUsb0JBQW9CO1lBQ3BCLE9BQU8sQ0FBQyxHQUFHLENBQUMsUUFBUSxFQUFFLElBQUksRUFBRSx5QkFBeUIsQ0FBQyxDQUFDO1lBQ3ZELE1BQU0sT0FBTyxHQUFHLElBQUksR0FBRyxFQUFFLENBQUM7WUFDMUIsTUFBTSxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsS0FBSyxFQUFDLENBQUMsRUFBQyxFQUFFO2dCQUNyQyxNQUFNLE1BQU0sR0FBRyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQztnQkFDeEMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLEVBQUU7b0JBQ3hCLE1BQU0sUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDO29CQUN2QixPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDO2lCQUNyQjtnQkFDRCxNQUFNLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUM7WUFDekMsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUNKLE9BQU8sQ0FBQyxHQUFHLENBQUMsUUFBUSxFQUFFLElBQUksRUFBRSwyQkFBMkIsQ0FBQyxDQUFDO1NBQzFEO0lBQ0gsQ0FBQyxDQUFBO0FBQ0gsQ0FBQztBQUVELE1BQWEsY0FBYztJQU96QixZQUFZLE1BQWU7UUFEM0IsYUFBUSxHQUFHLGdCQUFnQixDQUFDO1FBRTFCLElBQUksQ0FBQyxHQUFHLEdBQUcsTUFBTSxDQUFDLEdBQUcsSUFBSSxPQUFPLENBQUMsR0FBRyxFQUFFLENBQUM7UUFDdkMsSUFBSSxDQUFDLFNBQVMsR0FBRyxjQUFjLENBQUMsTUFBTSxDQUFDLFNBQVMsSUFBSSxVQUFVLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQzFFLElBQUksQ0FBQyxVQUFVLEdBQUcsY0FBYyxDQUFDLE1BQU0sQ0FBQyxVQUFVLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQzlELElBQUksQ0FBQyxVQUFVLEdBQUcsY0FBYyxDQUFDLE1BQU0sQ0FBQyxVQUFVLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQzlELElBQUksQ0FBQyxXQUFXLEdBQUcsTUFBTSxDQUFDLFdBQVcsS0FBSyxLQUFLLENBQUM7SUFDbEQsQ0FBQztJQUNPLEtBQUssQ0FBQyxVQUFVO1FBQ3RCLE1BQU0sT0FBTyxHQUFjLEVBQUUsQ0FBQztRQUM5QixNQUFNLFFBQVEsR0FBRyxLQUFLLEVBQUUsT0FBZSxFQUFFLEVBQUU7WUFDekMsTUFBTSxLQUFLLEdBQUcsTUFBTSxHQUFHLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFVBQVUsRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDO1lBQ3ZFLEtBQUssTUFBTSxJQUFJLElBQUksS0FBSyxFQUFFO2dCQUN4QixNQUFNLFVBQVUsR0FBRyxNQUFNLENBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFVBQVUsRUFBRSxPQUFPLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQztnQkFDakYsTUFBTSxLQUFLLEdBQUcsTUFBTSxHQUFHLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDM0QsSUFBSSxLQUFLLEVBQUU7b0JBQ1QsSUFBSSxLQUFLLENBQUMsV0FBVyxFQUFFLEVBQUU7d0JBQ3ZCLE1BQU0sUUFBUSxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxPQUFPLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO3FCQUM5RDt5QkFBTSxJQUFJLFVBQVUsQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFO3dCQUN0RSxNQUFNLFVBQVUsR0FBRyxNQUFNLENBQUMsU0FBUyxDQUNqQyxNQUFNLENBQUMsSUFBSSxDQUNULElBQUksQ0FBQyxVQUFVLEVBQ2YsTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFFLFVBQVUsQ0FBQyxDQUM3QyxDQUNGLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxLQUFLLENBQUMsQ0FBQzt3QkFDMUIsT0FBTyxDQUFDLElBQUksQ0FBQyxFQUFFLElBQUksRUFBRSxVQUFVLEVBQUUsSUFBSSxFQUFFLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDO3FCQUNwRDtpQkFDRjthQUNGO1FBQ0gsQ0FBQyxDQUFDO1FBQ0YsTUFBTSxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDcEIsT0FBTyxPQUFPLENBQUM7SUFDakIsQ0FBQztJQUNELGNBQWM7UUFDWixNQUFNLGlCQUFpQixHQUFHLGtDQUFtQixDQUFDLElBQUksQ0FBQztZQUNqRCxVQUFVLEVBQUUsTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxVQUFVLENBQUM7WUFDdEQsVUFBVSxFQUFFLE1BQU0sQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO1lBQ3JELFNBQVMsRUFBRSxLQUFLO1lBQ2hCLFNBQVMsRUFBRSxNQUFNO1NBQ2xCLENBQUMsQ0FBQztRQUNILE1BQU0sU0FBUyxHQUFHO1lBQ2hCLHdCQUFJLENBQUM7Z0JBQ0gsVUFBVSxFQUFFLE1BQU0sQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsVUFBVSxDQUFDO2dCQUN0RCxVQUFVLEVBQUUsTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7Z0JBQ3JELFNBQVMsRUFBRSxNQUFNO2dCQUNqQixTQUFTLEVBQUUsS0FBSztnQkFDaEIsV0FBVyxFQUFFLFlBQVk7YUFDMUIsQ0FBQztZQUNGLHNCQUFHLENBQUM7Z0JBQ0YsU0FBUyxFQUFFLElBQUk7Z0JBQ2YsVUFBVSxFQUFFLE1BQU0sQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO2dCQUNyRCxjQUFjLEVBQUUsQ0FBQyxJQUFZLEVBQUUsSUFBYSxFQUFFLEVBQUU7b0JBQzlDLE1BQU0sTUFBTSxHQUFHLGlCQUFpQixDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsQ0FBQztvQkFDN0MsSUFBSSxDQUFDLE1BQU0sRUFBRTt3QkFDWCxNQUFNLElBQUksS0FBSyxDQUFDLGdDQUFnQyxJQUFJLFlBQVksSUFBSSxHQUFHLENBQUMsQ0FBQztxQkFDMUU7b0JBQ0QsT0FBTyxNQUFNLENBQUM7Z0JBQ2hCLENBQUM7YUFDRixDQUFDO1lBQ0YsZ0NBQU0sQ0FBQztnQkFDTCxVQUFVLEVBQUUsTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxVQUFVLENBQUM7Z0JBQ3RELFNBQVMsRUFBRyxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztnQkFDckQsVUFBVSxFQUFFLE1BQU0sQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsVUFBVSxDQUFDO2dCQUN0RCxtQkFBbUIsRUFBRSxJQUFJO2dCQUN6QixrQkFBa0IsRUFBRSw2QkFBNkI7Z0JBQ2pELHFCQUFxQixFQUFFLElBQUksQ0FBQyxXQUFXO2FBQ3hDLENBQUM7WUFDRixLQUFLLEVBQUUsSUFBVSxFQUFFLE9BQWdCLEVBQUUsRUFBRTtnQkFDckMsSUFBSSxJQUFJLENBQUMsSUFBSSxZQUFZLDBCQUFXLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLEtBQUssSUFBSSxDQUFDLFFBQVEsRUFBRTtvQkFDeEUsTUFBTSxPQUFPLEdBQUcsTUFBTSxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7b0JBQ3hDLE1BQU0sT0FBTyxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxtQkFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztpQkFDaEc7WUFDSCxDQUFDO1NBQ0YsQ0FBQztRQUNGLElBQUksSUFBSSxDQUFDLFdBQVcsRUFBRTtZQUNwQixTQUFTLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQztnQkFDcEIsVUFBVSxFQUFFLElBQUksQ0FBQyxVQUFVO2dCQUMzQixrQkFBa0IsRUFBRSw2QkFBNkI7Z0JBQ2pELGFBQWEsRUFBRSxJQUFJLENBQUMsUUFBUTthQUM3QixDQUFDLENBQUMsQ0FBQztTQUNMO1FBQ0QsT0FBTyx3QkFBUyxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUN0QyxDQUFDO0NBQ0Y7QUF6RkQsd0NBeUZDIn0=