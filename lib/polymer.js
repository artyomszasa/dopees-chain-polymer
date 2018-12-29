"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fspath = require("path");
const fs = require("fs");
const dopees_chain_1 = require("dopees-chain");
const dopees_chain_sass_1 = require("dopees-chain-sass");
const dopees_chain_pug_1 = require("dopees-chain-pug");
const dopees_chain_typescript_1 = require("dopees-chain-typescript");
const t = require("@babel/types");
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
            const res = action(node.source.value);
            if (res) {
                node.source.value = res;
            }
        },
        ExportDeclaration(path) {
            const node = path.node;
            if ('ExportNamedDeclaration' === node.type || 'ExportAllDeclaration' === node.type) {
                if (node.source) {
                    const res = action(node.source.value);
                    if (res) {
                        node.source.value = res;
                    }
                }
            }
        }
    });
};
const keyDeepDependencies = 'polymer.deep.depepndencies';
const update = (source, toCopy, target, dedup, ast) => {
    const index = toCopy.findIndex(e => e.source === source);
    if (-1 !== index) {
        const entry = toCopy[index];
        entry.dedup = entry.dedup || dedup;
        entry.target = target;
        entry.ast = ast || entry.ast;
        return false;
    }
    else {
        toCopy.push({ source, target, ast });
        return true;
    }
};
const fixLocal = (path) => {
    if (!path.startsWith('..') && !path.startsWith('./') && !fspath.isAbsolute(path)) {
        return './' + path;
    }
    return path;
};
async function resolveDeep(targetRoot, npmRoot, context, toCopy, path, pathTarget) {
    const dedup = toCopy.find(e => e.source === path);
    if (dedup) {
        if (dedup.dedup) {
            // console.log(`--------- ${fspath.basename(path)}`)
            return;
        }
        else {
            // console.log(`+++++++++ ${fspath.basename(path)}`)
            dedup.dedup = true;
        }
    }
    const mtime = await fsmtime(path);
    if (!mtime) {
        throw new Error(`failed to get mtime for ${path}`);
    }
    let deps;
    let ast;
    const entry = await context.storage.getObject(`!${keyDeepDependencies}!${path}`);
    if (entry && entry.mtime >= mtime) {
        deps = entry.deps;
        ast = entry.ast;
    }
    else {
        // already parsed?
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
                plugins: ['@babel/syntax-dynamic-import'],
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
        findAllDependencies(ast, dep => { deps.push(dep); });
        await context.storage.setObject(`!${keyDeepDependencies}!${path}`, { mtime, ast, deps });
    }
    // process dependencies
    let externalDeps = {};
    const deepDependencies = [];
    for (const localPath of deps) {
        if (localPath.startsWith('./') || localPath.startsWith('../') || fspath.isAbsolute(localPath)) {
            // in-package dependency
            let source = fspath.normalize(fspath.join(fspath.dirname(path), localPath));
            if (!source.endsWith('.js')) {
                source += '.js';
            }
            const target = fspath.normalize(fspath.join(targetRoot, fspath.relative(npmRoot, source)));
            if (!localPath.endsWith('.js')) {
                externalDeps[localPath] = localPath + '.js';
            }
            update(source, toCopy, target, false);
            deepDependencies.push({ source, target });
        }
        else {
            // external dependency
            let source = fspath.normalize(fspath.join(npmRoot, localPath)); // source = dependency path relative to the npm root
            if (!source.endsWith('.js')) {
                source += '.js';
            }
            let target = fspath.normalize(fspath.join(targetRoot, fspath.relative(npmRoot, source)));
            // NOTE: same folder dependencies must start with './'
            const targetToTargetRoot = fspath.relative(fspath.dirname(pathTarget), targetRoot);
            let relative = fixLocal(fspath.join(targetToTargetRoot, localPath));
            if (!relative.endsWith('.js')) {
                relative += '.js';
            }
            externalDeps[localPath] = relative;
            update(source, toCopy, target, false);
            deepDependencies.push({ source, target });
        }
    }
    // console.log(`${fspath.basename(path)} => ${deepDependencies}`)
    // replace source with transplied one
    if (Object.keys(externalDeps).length) {
        // console.log(`${fspath.basename(path)} has external dependencies`);
        // console.log(externalDeps);
        const newAst = t.cloneDeep(ast);
        findAllDependencies(newAst, localPath => externalDeps[localPath]);
        const entry = toCopy.find(e => e.source === path);
        if (entry) {
            // console.log(entry);
            entry.ast = newAst;
        }
        // if (path.includes('router.js')) {
        //   console.log(toCopy);
        // }
    }
    // trigger deep resolve
    await Promise.all(deepDependencies.map(e => resolveDeep(targetRoot, npmRoot, context, toCopy, e.source, e.target)));
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
                        if (-1 === toCopy.findIndex(e => e.source === candidate && e.target === target)) {
                            toCopy.push({
                                source: candidate,
                                target
                            });
                        }
                    }
                }
            }
            // context.log('deploy', task, 'done updating dependency imports');
            context.log('deploy', task, 'done resolving source dependencies');
            // resolve deep dependencies
            context.log('deploy', task, 'resolving deep dependencies...');
            await Promise.all(toCopy.map(e => resolveDeep(targetRoot, npmRoot, context, toCopy, e.source, e.target)));
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
                if (e.ast) {
                    const babelOptions = {
                        filename: e.source,
                        code: true,
                        ast: false,
                        root: npmRoot,
                        rootMode: 'root'
                    };
                    const source = await context.getContents(dopees_chain_1.Task.file(e.source, context.basePath), 'utf-8');
                    const res = await babel.transformFromAstAsync(e.ast, source, babelOptions);
                    await fsp.writeFile(e.target, res.code, { encoding: 'utf-8' });
                }
                else {
                    context.log('deploy', task, `copying ${fspath.basename(e.source)} to ${fspath.relative(opts.targetRoot, e.target)}`);
                    await fsp.copyFile(e.source, e.target);
                }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicG9seW1lci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9wb2x5bWVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBQUEsK0JBQStCO0FBQy9CLHlCQUF5QjtBQUN6QiwrQ0FBb0c7QUFDcEcseURBQXlDO0FBQ3pDLHVEQUF1QztBQUN2QyxxRUFBa0U7QUFDbEUsa0NBQWtDO0FBQ2xDLHFDQUFxQztBQUNyQyw4Q0FBdUM7QUFDdkMsaUNBQWlDO0FBRWpDLE1BQU0sUUFBUSxHQUFHLENBQUMsSUFBWSxFQUF3QixFQUFFLENBQUMsSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUMsR0FBRyxFQUFFLEdBQUcsRUFBRSxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFFeEosTUFBTSxHQUFHLEdBQUcsRUFBRSxDQUFDLFFBQVEsQ0FBQztBQUV4QixNQUFNLE9BQU8sR0FBRyxDQUFDLElBQVksRUFBRSxFQUFFLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsS0FBSyxFQUFFLEdBQUcsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDO0FBV3hGLE1BQU0sY0FBYyxHQUFHLENBQUMsSUFBWSxFQUFFLElBQVksRUFBRSxFQUFFO0lBQ3BELElBQUksTUFBTSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsRUFBRTtRQUMzQixPQUFPLE1BQU0sQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUM7S0FDL0I7SUFDRCxPQUFPLE1BQU0sQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLENB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LEVBQUUsT0FBZ0IsRUFBRSxFQUFFO2dCQUNyQyxJQUFJLElBQUksQ0FBQyxJQUFJLFlBQVksMEJBQVcsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksS0FBSyxJQUFJLENBQUMsUUFBUSxFQUFFO29CQUN4RSxNQUFNLE9BQU8sR0FBRyxNQUFNLElBQUksQ0FBQyxVQUFVLEVBQUUsQ0FBQztvQkFDeEMsTUFBTSxPQUFPLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLG1CQUFJLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO2lCQUNoRztZQUNILENBQUM7U0FDRixDQUFDO1FBQ0YsSUFBSSxJQUFJLENBQUMsV0FBVyxFQUFFO1lBQ3BCLFNBQVMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDO2dCQUNwQixVQUFVLEVBQUUsSUFBSSxDQUFDLFVBQVU7Z0JBQzNCLGtCQUFrQixFQUFFLDZCQUE2QjtnQkFDakQsYUFBYSxFQUFFLElBQUksQ0FBQyxRQUFRO2FBQzdCLENBQUMsQ0FBQyxDQUFDO1NBQ0w7UUFDRCxPQUFPLHdCQUFTLENBQUMsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQ3RDLENBQUM7Q0FDRjtBQXpGRCx3Q0F5RkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBmc3BhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgKiBhcyBmcyBmcm9tICdmcyc7XG5pbXBvcnQgeyBFeGVjdXRvciwgRXhlY3V0b3JzLCBSZXZlcnNlUGF0aFJlc29sdmVyLCBUYXNrLCBDb250ZXh0LCBMb2dpY2FsTmFtZSB9IGZyb20gJ2RvcGVlcy1jaGFpbic7XG5pbXBvcnQgeyBzYXNzIH0gZnJvbSAnZG9wZWVzLWNoYWluLXNhc3MnO1xuaW1wb3J0IHsgcHVnIH0gZnJvbSAnZG9wZWVzLWNoYWluLXB1Zyc7XG5pbXBvcnQgeyBkb3BlZXMsIERlcGVuZGVuY3lFbnRyeSB9IGZyb20gJ2RvcGVlcy1jaGFpbi10eXBlc2NyaXB0JztcbmltcG9ydCAqIGFzIHQgZnJvbSAnQGJhYmVsL3R5cGVzJztcbmltcG9ydCAqIGFzIGJhYmVsIGZyb20gJ0BiYWJlbC9jb3JlJztcbmltcG9ydCB0cmF2ZXJzZSBmcm9tICdAYmFiZWwvdHJhdmVyc2UnO1xuaW1wb3J0ICogYXMgbWtkaXJwIGZyb20gJ21rZGlycCc7XG5cbmNvbnN0IG1rZGlycmVjID0gKHBhdGg6IHN0cmluZyk6IFByb21pc2U8bWtkaXJwLk1hZGU+ID0+IG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IG1rZGlycChwYXRoLCAoZXJyLCByZXMpID0+IGVyciA/IHJlamVjdChlcnIpIDogcmVzb2x2ZShyZXMpKSk7XG5cbmNvbnN0IGZzcCA9IGZzLnByb21pc2VzO1xuXG5jb25zdCBmc210aW1lID0gKHBhdGg6IHN0cmluZykgPT4gZnNwLnN0YXQocGF0aCkudGhlbihzdGF0cyA9PiBzdGF0cy5tdGltZSwgKCkgPT4gbnVsbCk7XG5cbmV4cG9ydCBpbnRlcmZhY2UgT3B0aW9ucyB7XG4gIHNvdXJjZVJvb3Q6IHN0cmluZztcbiAgdGFyZ2V0Um9vdDogc3RyaW5nO1xuICBidWlsZFJvb3Q/OiBzdHJpbmc7XG4gIGN3ZD86IHN0cmluZztcbiAgLyoqIFdoZW4gX3RydWVfIGFsbCBkZWVwIGRlcGVuZGVuY2llcyBhcmUgcmV3cml0dGVuIHdpdGggcmVzcG9jdCB0byB0aGUgdGFyZ2V0IGRpcmVjdG9yeS4gKi9cbiAgYXBwbGljYXRpb24/OiBib29sZWFuO1xufVxuXG5jb25zdCB0b0Fic29sdXRlUGF0aCA9IChwYXRoOiBzdHJpbmcsIGJhc2U6IHN0cmluZykgPT4ge1xuICBpZiAoZnNwYXRoLmlzQWJzb2x1dGUocGF0aCkpIHtcbiAgICByZXR1cm4gZnNwYXRoLm5vcm1hbGl6ZShwYXRoKTtcbiAgfVxuICByZXR1cm4gZnNwYXRoLm5vcm1hbGl6ZShmc3BhdGguam9pbihiYXNlLCBwYXRoKSk7XG59XG5cbmludGVyZmFjZSBUYXJnZXQge1xuICBwYXRoOiBzdHJpbmc7XG4gIGJhc2U6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIERlcGxveU9wdGlvbnMge1xuICB0YXJnZXRSb290OiBzdHJpbmc7XG4gIGJ1aWxkVGFza05hbWU6IHN0cmluZztcbiAgYWxsRGVwZW5kZW5jaWVzS2V5OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBEZWVwRGVwZW5kZW5jaWVzIHtcbiAgbXRpbWU6IERhdGU7XG4gIGFzdDogdC5Ob2RlO1xuICBkZXBzOiBzdHJpbmdbXTtcbn1cblxuaW50ZXJmYWNlIENhY2hlZEFzdCB7XG4gIG10aW1lOiBEYXRlLFxuICBhc3Q6IHQuTm9kZVxufVxuXG5jb25zdCBmaW5kQWxsRGVwZW5kZW5jaWVzID0gKGFzdDogdC5Ob2RlLCBhY3Rpb246IChzb3VyY2U6IHN0cmluZykgPT4gdm9pZHxzdHJpbmcpID0+IHtcbiAgcmV0dXJuIHRyYXZlcnNlKGFzdCwge1xuICAgIEltcG9ydERlY2xhcmF0aW9uKHBhdGgpIHtcbiAgICAgIGNvbnN0IG5vZGUgPSBwYXRoLm5vZGU7XG4gICAgICBjb25zdCByZXMgPSBhY3Rpb24obm9kZS5zb3VyY2UudmFsdWUpO1xuICAgICAgaWYgKHJlcykge1xuICAgICAgICBub2RlLnNvdXJjZS52YWx1ZSA9IHJlcztcbiAgICAgIH1cbiAgICB9LFxuICAgIEV4cG9ydERlY2xhcmF0aW9uKHBhdGgpIHtcbiAgICAgIGNvbnN0IG5vZGUgPSBwYXRoLm5vZGU7XG4gICAgICBpZiAoJ0V4cG9ydE5hbWVkRGVjbGFyYXRpb24nID09PSBub2RlLnR5cGUgfHwgJ0V4cG9ydEFsbERlY2xhcmF0aW9uJyA9PT0gbm9kZS50eXBlKSB7XG4gICAgICAgIGlmIChub2RlLnNvdXJjZSkge1xuICAgICAgICAgIGNvbnN0IHJlcyA9IGFjdGlvbihub2RlLnNvdXJjZS52YWx1ZSk7XG4gICAgICAgICAgaWYgKHJlcykge1xuICAgICAgICAgICAgbm9kZS5zb3VyY2UudmFsdWUgPSByZXM7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9KTtcbn07XG5cbmNvbnN0IGtleURlZXBEZXBlbmRlbmNpZXMgPSAncG9seW1lci5kZWVwLmRlcGVwbmRlbmNpZXMnO1xuXG5jb25zdCB1cGRhdGUgPSAoc291cmNlOiBzdHJpbmcsIHRvQ29weTogQXJyYXk8eyBzb3VyY2U6IHN0cmluZywgZGVkdXA/OiBib29sZWFuLCBhc3Q/OiB0Lk5vZGUsIHRhcmdldDogc3RyaW5nIH0+LCB0YXJnZXQ6IHN0cmluZywgZGVkdXA6IGJvb2xlYW4sIGFzdD86IHQuTm9kZSkgPT4ge1xuICBjb25zdCBpbmRleCA9IHRvQ29weS5maW5kSW5kZXgoZSA9PiBlLnNvdXJjZSA9PT0gc291cmNlKTtcbiAgaWYgKC0xICE9PSBpbmRleCkge1xuICAgIGNvbnN0IGVudHJ5ID0gdG9Db3B5W2luZGV4XTtcbiAgICBlbnRyeS5kZWR1cCA9IGVudHJ5LmRlZHVwIHx8IGRlZHVwO1xuICAgIGVudHJ5LnRhcmdldCA9IHRhcmdldDtcbiAgICBlbnRyeS5hc3QgPSBhc3QgfHwgZW50cnkuYXN0O1xuICAgIHJldHVybiBmYWxzZTtcbiAgfSBlbHNlIHtcbiAgICB0b0NvcHkucHVzaCh7IHNvdXJjZSwgdGFyZ2V0LCBhc3QgfSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuY29uc3QgZml4TG9jYWwgPSAocGF0aDogc3RyaW5nKSA9PiB7XG4gIGlmICghcGF0aC5zdGFydHNXaXRoKCcuLicpICYmICFwYXRoLnN0YXJ0c1dpdGgoJy4vJykgJiYgIWZzcGF0aC5pc0Fic29sdXRlKHBhdGgpKSB7XG4gICAgcmV0dXJuICcuLycgKyBwYXRoO1xuICB9XG4gIHJldHVybiBwYXRoO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlRGVlcCh0YXJnZXRSb290OiBzdHJpbmcsIG5wbVJvb3Q6IHN0cmluZywgY29udGV4dDogQ29udGV4dCwgdG9Db3B5OiBBcnJheTx7IHNvdXJjZTogc3RyaW5nLCBkZWR1cD86IGJvb2xlYW4sIGFzdD86IHQuTm9kZSwgdGFyZ2V0OiBzdHJpbmcgfT4sIHBhdGg6IHN0cmluZywgcGF0aFRhcmdldDogc3RyaW5nKSB7XG4gIGNvbnN0IGRlZHVwID0gdG9Db3B5LmZpbmQoZSA9PiBlLnNvdXJjZSA9PT0gcGF0aCk7XG4gIGlmIChkZWR1cCkge1xuICAgIGlmIChkZWR1cC5kZWR1cCkge1xuICAgICAgLy8gY29uc29sZS5sb2coYC0tLS0tLS0tLSAke2ZzcGF0aC5iYXNlbmFtZShwYXRoKX1gKVxuICAgICAgcmV0dXJuO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBjb25zb2xlLmxvZyhgKysrKysrKysrICR7ZnNwYXRoLmJhc2VuYW1lKHBhdGgpfWApXG4gICAgICBkZWR1cC5kZWR1cCA9IHRydWU7XG4gICAgfVxuICB9XG4gIGNvbnN0IG10aW1lID0gYXdhaXQgZnNtdGltZShwYXRoKTtcbiAgaWYgKCFtdGltZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgZmFpbGVkIHRvIGdldCBtdGltZSBmb3IgJHtwYXRofWApO1xuICB9XG4gIGxldCBkZXBzOiBzdHJpbmdbXTtcbiAgbGV0IGFzdDogdC5Ob2RlO1xuICBjb25zdCBlbnRyeSA9IGF3YWl0IGNvbnRleHQuc3RvcmFnZS5nZXRPYmplY3Q8RGVlcERlcGVuZGVuY2llcz4oYCEke2tleURlZXBEZXBlbmRlbmNpZXN9ISR7cGF0aH1gKTtcbiAgaWYgKGVudHJ5ICYmIGVudHJ5Lm10aW1lID49IG10aW1lKSB7XG4gICAgZGVwcyA9IGVudHJ5LmRlcHM7XG4gICAgYXN0ID0gZW50cnkuYXN0O1xuICB9IGVsc2Uge1xuICAgIC8vIGFscmVhZHkgcGFyc2VkP1xuICAgIGNvbnN0IGVudHJ5ID0gYXdhaXQgY29udGV4dC5zdG9yYWdlLmdldE9iamVjdDxDYWNoZWRBc3Q+KGAhcG9seW1lci5kZWVwLmFzdCEke3BhdGh9YCk7XG4gICAgaWYgKGVudHJ5ICYmIGVudHJ5Lm10aW1lID49IG10aW1lKSB7XG4gICAgICBhc3QgPSBlbnRyeS5hc3Q7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGJhYmVsT3B0aW9ucyA6IGJhYmVsLk9wdGlvbnMgPSB7XG4gICAgICAgIGZpbGVuYW1lOiBwYXRoLFxuICAgICAgICBhc3Q6IHRydWUsXG4gICAgICAgIHJvb3Q6IG5wbVJvb3QsXG4gICAgICAgIHJvb3RNb2RlOiAncm9vdCcsXG4gICAgICAgIHBsdWdpbnM6IFsnQGJhYmVsL3N5bnRheC1keW5hbWljLWltcG9ydCddLFxuICAgICAgICBwYXJzZXJPcHRzOiB7XG4gICAgICAgICAgc291cmNlVHlwZTogJ21vZHVsZSdcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIGNvbnN0IHNvdXJjZUNvZGUgPSBhd2FpdCBjb250ZXh0LmdldENvbnRlbnRzKFRhc2suZmlsZShwYXRoKSwgJ3V0Zi04Jyk7XG4gICAgICBhc3QgPSBhd2FpdCBiYWJlbC5wYXJzZUFzeW5jKHNvdXJjZUNvZGUsIGJhYmVsT3B0aW9ucyk7XG4gICAgICBhd2FpdCBjb250ZXh0LnN0b3JhZ2Uuc2V0T2JqZWN0KGAhcG9seW1lci5kZWVwLmFzdCEke3BhdGh9YCwgPENhY2hlZEFzdD57IG10aW1lLCBhc3QgfSk7XG4gICAgfVxuICAgIC8vIGdldCBkZXBlbmRlbmNpZXNcbiAgICBkZXBzID0gW107XG4gICAgZmluZEFsbERlcGVuZGVuY2llcyhhc3QsIGRlcCA9PiB7IGRlcHMucHVzaChkZXApOyB9KTtcbiAgICBhd2FpdCBjb250ZXh0LnN0b3JhZ2Uuc2V0T2JqZWN0KGAhJHtrZXlEZWVwRGVwZW5kZW5jaWVzfSEke3BhdGh9YCwgPERlZXBEZXBlbmRlbmNpZXM+eyBtdGltZSwgYXN0LCBkZXBzIH0pO1xuICB9XG4gIC8vIHByb2Nlc3MgZGVwZW5kZW5jaWVzXG4gIGxldCBleHRlcm5hbERlcHMgOiB7IFtrZXk6c3RyaW5nXTogc3RyaW5nfHVuZGVmaW5lZCB9ID0ge307XG4gIGNvbnN0IGRlZXBEZXBlbmRlbmNpZXM6IHsgc291cmNlOnN0cmluZywgdGFyZ2V0OnN0cmluZyB9W10gPSBbXTtcbiAgZm9yIChjb25zdCBsb2NhbFBhdGggb2YgZGVwcykge1xuICAgIGlmIChsb2NhbFBhdGguc3RhcnRzV2l0aCgnLi8nKSB8fCBsb2NhbFBhdGguc3RhcnRzV2l0aCgnLi4vJykgfHwgZnNwYXRoLmlzQWJzb2x1dGUobG9jYWxQYXRoKSkge1xuICAgICAgLy8gaW4tcGFja2FnZSBkZXBlbmRlbmN5XG4gICAgICBsZXQgc291cmNlID0gZnNwYXRoLm5vcm1hbGl6ZShmc3BhdGguam9pbihmc3BhdGguZGlybmFtZShwYXRoKSwgbG9jYWxQYXRoKSk7XG4gICAgICBpZiAoIXNvdXJjZS5lbmRzV2l0aCgnLmpzJykpIHtcbiAgICAgICAgc291cmNlICs9ICcuanMnO1xuICAgICAgfVxuICAgICAgY29uc3QgdGFyZ2V0ID0gZnNwYXRoLm5vcm1hbGl6ZShmc3BhdGguam9pbih0YXJnZXRSb290LCBmc3BhdGgucmVsYXRpdmUobnBtUm9vdCwgc291cmNlKSkpO1xuICAgICAgaWYgKCFsb2NhbFBhdGguZW5kc1dpdGgoJy5qcycpKSB7XG4gICAgICAgIGV4dGVybmFsRGVwc1tsb2NhbFBhdGhdID0gbG9jYWxQYXRoICsgJy5qcyc7XG4gICAgICB9XG4gICAgICB1cGRhdGUoc291cmNlLCB0b0NvcHksIHRhcmdldCwgZmFsc2UpO1xuICAgICAgZGVlcERlcGVuZGVuY2llcy5wdXNoKHsgc291cmNlLCB0YXJnZXQgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIGV4dGVybmFsIGRlcGVuZGVuY3lcbiAgICAgIGxldCBzb3VyY2UgPSBmc3BhdGgubm9ybWFsaXplKGZzcGF0aC5qb2luKG5wbVJvb3QsIGxvY2FsUGF0aCkpOyAvLyBzb3VyY2UgPSBkZXBlbmRlbmN5IHBhdGggcmVsYXRpdmUgdG8gdGhlIG5wbSByb290XG4gICAgICBpZiAoIXNvdXJjZS5lbmRzV2l0aCgnLmpzJykpIHtcbiAgICAgICAgc291cmNlICs9ICcuanMnO1xuICAgICAgfVxuICAgICAgbGV0IHRhcmdldCA9IGZzcGF0aC5ub3JtYWxpemUoZnNwYXRoLmpvaW4odGFyZ2V0Um9vdCwgZnNwYXRoLnJlbGF0aXZlKG5wbVJvb3QsIHNvdXJjZSkpKTtcbiAgICAgIC8vIE5PVEU6IHNhbWUgZm9sZGVyIGRlcGVuZGVuY2llcyBtdXN0IHN0YXJ0IHdpdGggJy4vJ1xuICAgICAgY29uc3QgdGFyZ2V0VG9UYXJnZXRSb290ID0gZnNwYXRoLnJlbGF0aXZlKGZzcGF0aC5kaXJuYW1lKHBhdGhUYXJnZXQpLCB0YXJnZXRSb290KTtcbiAgICAgIGxldCByZWxhdGl2ZSA9IGZpeExvY2FsKGZzcGF0aC5qb2luKHRhcmdldFRvVGFyZ2V0Um9vdCwgbG9jYWxQYXRoKSk7XG4gICAgICBpZiAoIXJlbGF0aXZlLmVuZHNXaXRoKCcuanMnKSkge1xuICAgICAgICByZWxhdGl2ZSArPSAnLmpzJztcbiAgICAgIH1cbiAgICAgIGV4dGVybmFsRGVwc1tsb2NhbFBhdGhdID0gcmVsYXRpdmU7XG4gICAgICB1cGRhdGUoc291cmNlLCB0b0NvcHksIHRhcmdldCwgZmFsc2UpO1xuICAgICAgZGVlcERlcGVuZGVuY2llcy5wdXNoKHsgc291cmNlLCB0YXJnZXQgfSk7XG4gICAgfVxuICB9XG4gIC8vIGNvbnNvbGUubG9nKGAke2ZzcGF0aC5iYXNlbmFtZShwYXRoKX0gPT4gJHtkZWVwRGVwZW5kZW5jaWVzfWApXG4gIC8vIHJlcGxhY2Ugc291cmNlIHdpdGggdHJhbnNwbGllZCBvbmVcbiAgaWYgKE9iamVjdC5rZXlzKGV4dGVybmFsRGVwcykubGVuZ3RoKSB7XG4gICAgLy8gY29uc29sZS5sb2coYCR7ZnNwYXRoLmJhc2VuYW1lKHBhdGgpfSBoYXMgZXh0ZXJuYWwgZGVwZW5kZW5jaWVzYCk7XG4gICAgLy8gY29uc29sZS5sb2coZXh0ZXJuYWxEZXBzKTtcbiAgICBjb25zdCBuZXdBc3QgPSB0LmNsb25lRGVlcChhc3QpO1xuXG4gICAgZmluZEFsbERlcGVuZGVuY2llcyhuZXdBc3QsIGxvY2FsUGF0aCA9PiBleHRlcm5hbERlcHNbbG9jYWxQYXRoXSk7XG4gICAgY29uc3QgZW50cnkgPSB0b0NvcHkuZmluZChlID0+IGUuc291cmNlID09PSBwYXRoKTtcbiAgICBpZiAoZW50cnkpIHtcbiAgICAgIC8vIGNvbnNvbGUubG9nKGVudHJ5KTtcbiAgICAgIGVudHJ5LmFzdCA9IG5ld0FzdDtcbiAgICB9XG4gICAgLy8gaWYgKHBhdGguaW5jbHVkZXMoJ3JvdXRlci5qcycpKSB7XG4gICAgLy8gICBjb25zb2xlLmxvZyh0b0NvcHkpO1xuICAgIC8vIH1cbiAgfVxuICAvLyB0cmlnZ2VyIGRlZXAgcmVzb2x2ZVxuICBhd2FpdCBQcm9taXNlLmFsbChkZWVwRGVwZW5kZW5jaWVzLm1hcChlID0+IHJlc29sdmVEZWVwKHRhcmdldFJvb3QsIG5wbVJvb3QsIGNvbnRleHQsIHRvQ29weSwgZS5zb3VyY2UsIGUudGFyZ2V0KSkpO1xufVxuXG5mdW5jdGlvbiB1bmlxdWU8VD4oc291cmNlOiBUW10pOiBUW10ge1xuICBjb25zdCByZXN1bHQ6IFRbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2Ygc291cmNlKSB7XG4gICAgaWYgKCFyZXN1bHQuc29tZShpID0+IGkgPT09IGl0ZW0pKSB7XG4gICAgICByZXN1bHQucHVzaChpdGVtKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxuZnVuY3Rpb24gZGVwbG95KG9wdHM6IERlcGxveU9wdGlvbnMpOiBFeGVjdXRvciB7XG4gIGNvbnN0IHsgdGFyZ2V0Um9vdCwgYnVpbGRUYXNrTmFtZSwgYWxsRGVwZW5kZW5jaWVzS2V5IH0gPSBvcHRzO1xuICByZXR1cm4gYXN5bmMgKHRhc2s6IFRhc2ssIGNvbnRleHQ6IENvbnRleHQpID0+IHtcbiAgICBpZiAodGFzay5uYW1lIGluc3RhbmNlb2YgTG9naWNhbE5hbWUgJiYgdGFzay5uYW1lLm5hbWUgPT09IGJ1aWxkVGFza05hbWUpIHtcbiAgICAgIGNvbnN0IGRlcHMgPSBhd2FpdCBjb250ZXh0LnN0b3JhZ2UuZ2V0T2JqZWN0PERlcGVuZGVuY3lFbnRyeVtdPihhbGxEZXBlbmRlbmNpZXNLZXkpO1xuICAgICAgaWYgKCFkZXBzKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignbm8gZGVwZW5kZW5jaWVzIGhhcyBiZWVuIHBvcHVsYXRlZCcpO1xuICAgICAgfVxuICAgICAgY29uc3Qgcm9vdCA9IGNvbnRleHQuYmFzZVBhdGg7XG4gICAgICBjb25zdCBucG1Sb290ID0gZnNwYXRoLmpvaW4ocm9vdCwgJ25vZGVfbW9kdWxlcycpO1xuICAgICAgLy8gZmxhdHRlbiBkZXBlbmRlbmNpZXNcbiAgICAgIGNvbnN0IHRvQ29weTogQXJyYXk8eyBzb3VyY2U6IHN0cmluZywgYXN0PzogdC5Ob2RlLCB0YXJnZXQ6IHN0cmluZyB9PiA9IFtdO1xuICAgICAgLy8gY29uc3QgaW1wb3J0czogQXJyYXk8eyBuYW1lOiBzdHJpbmcsIHRhcmdldDogc3RyaW5nIH0+ID0gW107XG4gICAgICBjb250ZXh0LmxvZygnZGVwbG95JywgdGFzaywgJ3Jlc29sdmluZyBzb3VyY2UgZGVwZW5kZW5jaWVzLi4uJyk7XG4gICAgICBjb25zdCBhbGxTb3VyY2VzID0gdW5pcXVlKGRlcHMubWFwKGRlcCA9PiBkZXAuc291cmNlKSk7XG4gICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGRlcHMpIHtcbiAgICAgICAgZm9yIChjb25zdCBkZXAgb2YgZW50cnkuZGVwZW5kZW5jaWVzKSB7XG4gICAgICAgICAgY29uc3QgcG9zc2libGVTb3VyY2UgPSBmc3BhdGgubm9ybWFsaXplKGZzcGF0aC5qb2luKGZzcGF0aC5kaXJuYW1lKGVudHJ5LnNvdXJjZSksIGRlcCkpO1xuICAgICAgICAgIGlmICghYWxsU291cmNlcy5zb21lKHggPT4geCA9PT0gcG9zc2libGVTb3VyY2UpKSB7XG4gICAgICAgICAgICBjb25zdCBkZXBlbmRlbmN5ID0gZnNwYXRoLnJlbGF0aXZlKHRhcmdldFJvb3QsIHBvc3NpYmxlU291cmNlKTtcbiAgICAgICAgICAgIGxldCBtdGltZSA6IERhdGV8bnVsbDtcbiAgICAgICAgICAgIC8vIHRyeSBqcyBpbiBtb2R1bGVzXG4gICAgICAgICAgICBsZXQgY2FuZGlkYXRlID0gZnNwYXRoLmpvaW4obnBtUm9vdCwgZGVwZW5kZW5jeSk7XG4gICAgICAgICAgICBtdGltZSA9IGF3YWl0IGZzbXRpbWUoY2FuZGlkYXRlKTtcbiAgICAgICAgICAgIGlmICghbXRpbWUpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGB1bmFibGUgdG8gcmVzb2x2ZSAke2RlcGVuZGVuY3l9YCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCB0YXJnZXQgPSBmc3BhdGguam9pbih0YXJnZXRSb290LCBkZXBlbmRlbmN5KTtcbiAgICAgICAgICAgIGlmICgtMSA9PT0gdG9Db3B5LmZpbmRJbmRleChlID0+IGUuc291cmNlID09PSBjYW5kaWRhdGUgJiYgZS50YXJnZXQgPT09IHRhcmdldCkpIHtcbiAgICAgICAgICAgICAgdG9Db3B5LnB1c2goe1xuICAgICAgICAgICAgICAgIHNvdXJjZTogY2FuZGlkYXRlLFxuICAgICAgICAgICAgICAgIHRhcmdldFxuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIC8vIGNvbnRleHQubG9nKCdkZXBsb3knLCB0YXNrLCAnZG9uZSB1cGRhdGluZyBkZXBlbmRlbmN5IGltcG9ydHMnKTtcbiAgICAgIGNvbnRleHQubG9nKCdkZXBsb3knLCB0YXNrLCAnZG9uZSByZXNvbHZpbmcgc291cmNlIGRlcGVuZGVuY2llcycpO1xuICAgICAgLy8gcmVzb2x2ZSBkZWVwIGRlcGVuZGVuY2llc1xuICAgICAgY29udGV4dC5sb2coJ2RlcGxveScsIHRhc2ssICdyZXNvbHZpbmcgZGVlcCBkZXBlbmRlbmNpZXMuLi4nKTtcbiAgICAgIGF3YWl0IFByb21pc2UuYWxsKHRvQ29weS5tYXAoZSA9PiByZXNvbHZlRGVlcCh0YXJnZXRSb290LCBucG1Sb290LCBjb250ZXh0LCB0b0NvcHksIGUuc291cmNlLCBlLnRhcmdldCkpKTtcbiAgICAgIGNvbnRleHQubG9nKCdkZXBsb3knLCB0YXNrLCAnZG9uZSByZXNvbHZpbmcgZGVlcCBkZXBlbmRlbmNpZXMnKTtcbiAgICAgIC8vIGNvcHkgZGVwZW5kZW5jaWVzXG4gICAgICBjb250ZXh0LmxvZygnZGVwbG95JywgdGFzaywgJ2NvcHlpbmcgZGVwZW5kZW5jaWVzLi4uJyk7XG4gICAgICBjb25zdCBjcmVhdGVkID0gbmV3IFNldCgpO1xuICAgICAgYXdhaXQgUHJvbWlzZS5hbGwodG9Db3B5Lm1hcChhc3luYyBlID0+IHtcbiAgICAgICAgY29uc3QgZm9sZGVyID0gZnNwYXRoLmRpcm5hbWUoZS50YXJnZXQpO1xuICAgICAgICBpZiAoIWNyZWF0ZWQuaGFzKGZvbGRlcikpIHtcbiAgICAgICAgICBhd2FpdCBta2RpcnJlYyhmb2xkZXIpO1xuICAgICAgICAgIGNyZWF0ZWQuYWRkKGZvbGRlcik7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGUuYXN0KSB7XG4gICAgICAgICAgY29uc3QgYmFiZWxPcHRpb25zIDogYmFiZWwuT3B0aW9ucyA9IHtcbiAgICAgICAgICAgIGZpbGVuYW1lOiBlLnNvdXJjZSxcbiAgICAgICAgICAgIGNvZGU6IHRydWUsXG4gICAgICAgICAgICBhc3Q6IGZhbHNlLFxuICAgICAgICAgICAgcm9vdDogbnBtUm9vdCxcbiAgICAgICAgICAgIHJvb3RNb2RlOiAncm9vdCdcbiAgICAgICAgICB9O1xuICAgICAgICAgIGNvbnN0IHNvdXJjZSA9IGF3YWl0IGNvbnRleHQuZ2V0Q29udGVudHMoVGFzay5maWxlKGUuc291cmNlLCBjb250ZXh0LmJhc2VQYXRoKSwgJ3V0Zi04Jyk7XG4gICAgICAgICAgY29uc3QgcmVzID0gYXdhaXQgYmFiZWwudHJhbnNmb3JtRnJvbUFzdEFzeW5jKGUuYXN0LCBzb3VyY2UsIGJhYmVsT3B0aW9ucyk7XG4gICAgICAgICAgYXdhaXQgZnNwLndyaXRlRmlsZShlLnRhcmdldCwgcmVzLmNvZGUsIHsgZW5jb2Rpbmc6ICd1dGYtOCcgfSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29udGV4dC5sb2coJ2RlcGxveScsIHRhc2ssIGBjb3B5aW5nICR7ZnNwYXRoLmJhc2VuYW1lKGUuc291cmNlKX0gdG8gJHtmc3BhdGgucmVsYXRpdmUob3B0cy50YXJnZXRSb290LCBlLnRhcmdldCl9YClcbiAgICAgICAgICBhd2FpdCBmc3AuY29weUZpbGUoZS5zb3VyY2UsIGUudGFyZ2V0KTtcbiAgICAgICAgfVxuICAgICAgfSkpO1xuICAgICAgY29udGV4dC5sb2coJ2RlcGxveScsIHRhc2ssICdkb25lIGNvcHlpbmcgZGVwZW5kZW5jaWVzJyk7XG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBQb2x5bWVyUHJvamVjdCB7XG4gIHNvdXJjZVJvb3Q6IHN0cmluZztcbiAgdGFyZ2V0Um9vdDogc3RyaW5nO1xuICBidWlsZFJvb3Q6IHN0cmluZztcbiAgY3dkOiBzdHJpbmc7XG4gIGFwcGxpY2F0aW9uOiBib29sZWFuO1xuICB0YXNrTmFtZSA9ICdkb3BlZXMtcG9seW1lcic7XG4gIGNvbnN0cnVjdG9yKGNvbmZpZzogT3B0aW9ucykge1xuICAgIHRoaXMuY3dkID0gY29uZmlnLmN3ZCB8fCBwcm9jZXNzLmN3ZCgpO1xuICAgIHRoaXMuYnVpbGRSb290ID0gdG9BYnNvbHV0ZVBhdGgoY29uZmlnLmJ1aWxkUm9vdCB8fCAnLi8uYnVpbGQnLCB0aGlzLmN3ZCk7XG4gICAgdGhpcy5zb3VyY2VSb290ID0gdG9BYnNvbHV0ZVBhdGgoY29uZmlnLnNvdXJjZVJvb3QsIHRoaXMuY3dkKTtcbiAgICB0aGlzLnRhcmdldFJvb3QgPSB0b0Fic29sdXRlUGF0aChjb25maWcudGFyZ2V0Um9vdCwgdGhpcy5jd2QpO1xuICAgIHRoaXMuYXBwbGljYXRpb24gPSBjb25maWcuYXBwbGljYXRpb24gIT09IGZhbHNlO1xuICB9XG4gIHByaXZhdGUgYXN5bmMgZ2V0VGFyZ2V0cygpIHtcbiAgICBjb25zdCB0YXJnZXRzIDogVGFyZ2V0W10gPSBbXTtcbiAgICBjb25zdCB0cmF2ZXJzZSA9IGFzeW5jIChzdWJwYXRoOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IG5hbWVzID0gYXdhaXQgZnNwLnJlYWRkaXIoZnNwYXRoLmpvaW4odGhpcy5zb3VyY2VSb290LCBzdWJwYXRoKSk7XG4gICAgICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMpIHtcbiAgICAgICAgY29uc3Qgc291cmNlUGF0aCA9IGZzcGF0aC5ub3JtYWxpemUoZnNwYXRoLmpvaW4odGhpcy5zb3VyY2VSb290LCBzdWJwYXRoLCBuYW1lKSk7XG4gICAgICAgIGNvbnN0IHN0YXRzID0gYXdhaXQgZnNwLnN0YXQoc291cmNlUGF0aCkuY2F0Y2goKCkgPT4gbnVsbCk7XG4gICAgICAgIGlmIChzdGF0cykge1xuICAgICAgICAgIGlmIChzdGF0cy5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICAgICAgICBhd2FpdCB0cmF2ZXJzZShmc3BhdGgubm9ybWFsaXplKGZzcGF0aC5qb2luKHN1YnBhdGgsIG5hbWUpKSk7XG4gICAgICAgICAgfSBlbHNlIGlmIChzb3VyY2VQYXRoLmVuZHNXaXRoKCcudHMnKSAmJiAhc291cmNlUGF0aC5lbmRzV2l0aCgnLmQudHMnKSkge1xuICAgICAgICAgICAgY29uc3QgdGFyZ2V0UGF0aCA9IGZzcGF0aC5ub3JtYWxpemUoXG4gICAgICAgICAgICAgIGZzcGF0aC5qb2luKFxuICAgICAgICAgICAgICAgIHRoaXMudGFyZ2V0Um9vdCxcbiAgICAgICAgICAgICAgICBmc3BhdGgucmVsYXRpdmUodGhpcy5zb3VyY2VSb290LCBzb3VyY2VQYXRoKVxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICApLnJlcGxhY2UoL1xcLnRzJC8sICcuanMnKTtcbiAgICAgICAgICAgIHRhcmdldHMucHVzaCh7IHBhdGg6IHRhcmdldFBhdGgsIGJhc2U6IHRoaXMuY3dkIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH07XG4gICAgYXdhaXQgdHJhdmVyc2UoJy4nKTtcbiAgICByZXR1cm4gdGFyZ2V0cztcbiAgfVxuICBjcmVhdGVFeGVjdXRvcigpOiBFeGVjdXRvciB7XG4gICAgY29uc3QgcHVnU291cmNlUmVzb2x2ZXIgPSBSZXZlcnNlUGF0aFJlc29sdmVyLmZyb20oe1xuICAgICAgc291cmNlUm9vdDogZnNwYXRoLnJlbGF0aXZlKHRoaXMuY3dkLCB0aGlzLnNvdXJjZVJvb3QpLFxuICAgICAgdGFyZ2V0Um9vdDogZnNwYXRoLnJlbGF0aXZlKHRoaXMuY3dkLCB0aGlzLmJ1aWxkUm9vdCksXG4gICAgICBzb3VyY2VFeHQ6ICdwdWcnLFxuICAgICAgdGFyZ2V0RXh0OiAnaHRtbCdcbiAgICB9KTtcbiAgICBjb25zdCBleGVjdXRvcnMgPSBbXG4gICAgICBzYXNzKHtcbiAgICAgICAgc291cmNlUm9vdDogZnNwYXRoLnJlbGF0aXZlKHRoaXMuY3dkLCB0aGlzLnNvdXJjZVJvb3QpLFxuICAgICAgICB0YXJnZXRSb290OiBmc3BhdGgucmVsYXRpdmUodGhpcy5jd2QsIHRoaXMuYnVpbGRSb290KSxcbiAgICAgICAgc291cmNlRXh0OiAnc2NzcycsXG4gICAgICAgIHRhcmdldEV4dDogJ2NzcycsXG4gICAgICAgIG91dHB1dFN0eWxlOiAnY29tcHJlc3NlZCdcbiAgICAgIH0pLFxuICAgICAgcHVnKHtcbiAgICAgICAgaW5saW5lQ3NzOiB0cnVlLFxuICAgICAgICB0YXJnZXRSb290OiBmc3BhdGgucmVsYXRpdmUodGhpcy5jd2QsIHRoaXMuYnVpbGRSb290KSxcbiAgICAgICAgc291cmNlUmVzb2x2ZXI6IChwYXRoOiBzdHJpbmcsIGJhc2U/OiBzdHJpbmcpID0+IHtcbiAgICAgICAgICBjb25zdCBzb3VyY2UgPSBwdWdTb3VyY2VSZXNvbHZlcihwYXRoLCBiYXNlKTtcbiAgICAgICAgICBpZiAoIXNvdXJjZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGB1bmFibGUgdG8gcmVzb2x2ZSBzb3VyY2UgZm9yICR7cGF0aH0gKGJhc2UgPSAke2Jhc2V9KWApO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gc291cmNlO1xuICAgICAgICB9XG4gICAgICB9KSxcbiAgICAgIGRvcGVlcyh7XG4gICAgICAgIHNvdXJjZVJvb3Q6IGZzcGF0aC5yZWxhdGl2ZSh0aGlzLmN3ZCwgdGhpcy5zb3VyY2VSb290KSxcbiAgICAgICAgYnVpbGRSb290OiAgZnNwYXRoLnJlbGF0aXZlKHRoaXMuY3dkLCB0aGlzLmJ1aWxkUm9vdCksXG4gICAgICAgIHRhcmdldFJvb3Q6IGZzcGF0aC5yZWxhdGl2ZSh0aGlzLmN3ZCwgdGhpcy50YXJnZXRSb290KSxcbiAgICAgICAgc2F2ZUFsbERlcGVuZGVuY2llczogdHJ1ZSxcbiAgICAgICAgYWxsRGVwZW5kZW5jaWVzS2V5OiAnZG9wZWVzLnBvbHltZXIuZGVwZW5kZW5jaWVzJyxcbiAgICAgICAgdXBkYXRlRXh0ZXJuYWxJbXBvcnRzOiB0aGlzLmFwcGxpY2F0aW9uXG4gICAgICB9KSxcbiAgICAgIGFzeW5jICh0YXNrOiBUYXNrLCBjb250ZXh0OiBDb250ZXh0KSA9PiB7XG4gICAgICAgIGlmICh0YXNrLm5hbWUgaW5zdGFuY2VvZiBMb2dpY2FsTmFtZSAmJiB0YXNrLm5hbWUubmFtZSA9PT0gdGhpcy50YXNrTmFtZSkge1xuICAgICAgICAgIGNvbnN0IHRhcmdldHMgPSBhd2FpdCB0aGlzLmdldFRhcmdldHMoKTtcbiAgICAgICAgICBhd2FpdCBQcm9taXNlLmFsbCh0YXJnZXRzLm1hcCh0YXJnZXQgPT4gY29udGV4dC5leGVjdXRlKFRhc2suZmlsZSh0YXJnZXQucGF0aCwgdGFyZ2V0LmJhc2UpKSkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgXTtcbiAgICBpZiAodGhpcy5hcHBsaWNhdGlvbikge1xuICAgICAgZXhlY3V0b3JzLnB1c2goZGVwbG95KHtcbiAgICAgICAgdGFyZ2V0Um9vdDogdGhpcy50YXJnZXRSb290LFxuICAgICAgICBhbGxEZXBlbmRlbmNpZXNLZXk6ICdkb3BlZXMucG9seW1lci5kZXBlbmRlbmNpZXMnLFxuICAgICAgICBidWlsZFRhc2tOYW1lOiB0aGlzLnRhc2tOYW1lXG4gICAgICB9KSk7XG4gICAgfVxuICAgIHJldHVybiBFeGVjdXRvcnMuY29tYmluZShleGVjdXRvcnMpO1xuICB9XG59Il19