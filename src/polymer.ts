import * as fspath from 'path';
import * as fs from 'fs';
import { Executor, Executors, ReversePathResolver, Task, Context, LogicalName } from 'dopees-chain';
import { sass } from 'dopees-chain-sass';
import { pug } from 'dopees-chain-pug';
import { dopees, DependencyEntry } from 'dopees-chain-typescript';
import * as t from '@babel/types';
import * as babel from '@babel/core';
import traverse from '@babel/traverse';
import * as mkdirp from 'mkdirp';

const mkdirrec = (path: string): Promise<mkdirp.Made> => new Promise((resolve, reject) => mkdirp(path, (err, res) => err ? reject(err) : resolve(res)));

const fsp = fs.promises;

const fsmtime = (path: string) => fsp.stat(path).then(stats => stats.mtime, () => null);

export interface Options {
  sourceRoot: string;
  targetRoot: string;
  buildRoot?: string;
  cwd?: string;
  /** When _true_ all deep dependencies are rewritten with respoct to the target directory. */
  application?: boolean;
}

const toAbsolutePath = (path: string, base: string) => {
  if (fspath.isAbsolute(path)) {
    return fspath.normalize(path);
  }
  return fspath.normalize(fspath.join(base, path));
}

interface Target {
  path: string;
  base: string;
}

interface DeployOptions {
  targetRoot: string;
  buildTaskName: string;
  allDependenciesKey: string;
}

interface DeepDependencies {
  mtime: Date;
  ast: t.Node;
  deps: string[];
}

interface CachedAst {
  mtime: Date,
  ast: t.Node
}

const findAllDependencies = (ast: t.Node, action: (source: string) => void|string) => {
  return traverse(ast, {
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

const update = (source: string, toCopy: Array<{ source: string, dedup?: boolean, ast?: t.Node, target: string }>, target: string, dedup: boolean, ast?: t.Node) => {
  const index = toCopy.findIndex(e => e.source === source);
  if (-1 !== index) {
    const entry = toCopy[index];
    entry.dedup = entry.dedup || dedup;
    entry.target = target;
    entry.ast = ast || entry.ast;
    return false;
  } else {
    toCopy.push({ source, target, ast });
    return true;
  }
}

const fixLocal = (path: string) => {
  if (!path.startsWith('..') && !path.startsWith('./') && !fspath.isAbsolute(path)) {
    return './' + path;
  }
  return path;
}

async function resolveDeep(targetRoot: string, npmRoot: string, context: Context, toCopy: Array<{ source: string, dedup?: boolean, ast?: t.Node, target: string }>, path: string, pathTarget: string) {
  const dedup = toCopy.find(e => e.source === path);
  if (dedup) {
    if (dedup.dedup) {
      // console.log(`--------- ${fspath.basename(path)}`)
      return;
    } else {
      // console.log(`+++++++++ ${fspath.basename(path)}`)
      dedup.dedup = true;
    }
  }
  const mtime = await fsmtime(path);
  if (!mtime) {
    throw new Error(`failed to get mtime for ${path}`);
  }
  let deps: string[];
  let ast: t.Node;
  const entry = await context.storage.getObject<DeepDependencies>(`!${keyDeepDependencies}!${path}`);
  if (entry && entry.mtime >= mtime) {
    deps = entry.deps;
    ast = entry.ast;
  } else {
    // already parsed?
    const entry = await context.storage.getObject<CachedAst>(`!polymer.deep.ast!${path}`);
    if (entry && entry.mtime >= mtime) {
      ast = entry.ast;
    } else {
      const babelOptions : babel.Options = {
        filename: path,
        ast: true,
        root: npmRoot,
        rootMode: 'root',
        plugins: ['@babel/syntax-dynamic-import'],
        parserOpts: {
          sourceType: 'module'
        }
      };
      const sourceCode = await context.getContents(Task.file(path), 'utf-8');
      ast = await babel.parseAsync(sourceCode, babelOptions);
      await context.storage.setObject(`!polymer.deep.ast!${path}`, <CachedAst>{ mtime, ast });
    }
    // get dependencies
    deps = [];
    findAllDependencies(ast, dep => { deps.push(dep); });
    await context.storage.setObject(`!${keyDeepDependencies}!${path}`, <DeepDependencies>{ mtime, ast, deps });
  }
  // process dependencies
  let externalDeps : { [key:string]: string|undefined } = {};
  const deepDependencies: { source:string, target:string }[] = [];
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
    } else {
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

function unique<T>(source: T[]): T[] {
  const result: T[] = [];
  for (const item of source) {
    if (!result.some(i => i === item)) {
      result.push(item);
    }
  }
  return result;
}

function deploy(opts: DeployOptions): Executor {
  const { targetRoot, buildTaskName, allDependenciesKey } = opts;
  return async (task: Task, context: Context) => {
    if (task.name instanceof LogicalName && task.name.name === buildTaskName) {
      const deps = await context.storage.getObject<DependencyEntry[]>(allDependenciesKey);
      if (!deps) {
        throw new Error('no dependencies has been populated');
      }
      const root = context.basePath;
      const npmRoot = fspath.join(root, 'node_modules');
      // flatten dependencies
      const toCopy: Array<{ source: string, ast?: t.Node, target: string }> = [];
      // const imports: Array<{ name: string, target: string }> = [];
      context.log('deploy', task, 'resolving source dependencies...');
      const allSources = unique(deps.map(dep => dep.source));
      for (const entry of deps) {
        for (const dep of entry.dependencies) {
          const possibleSource = fspath.normalize(fspath.join(fspath.dirname(entry.source), dep));
          if (!allSources.some(x => x === possibleSource)) {
            const dependency = fspath.relative(targetRoot, possibleSource);
            let mtime : Date|null;
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
      await Promise.all(toCopy.map(async e => {
        const folder = fspath.dirname(e.target);
        if (!created.has(folder)) {
          await mkdirrec(folder);
          created.add(folder);
        }
        if (e.ast) {
          const babelOptions : babel.Options = {
            filename: e.source,
            code: true,
            ast: false,
            root: npmRoot,
            rootMode: 'root'
          };
          const source = await context.getContents(Task.file(e.source, context.basePath), 'utf-8');
          const res = await babel.transformFromAstAsync(e.ast, source, babelOptions);
          await fsp.writeFile(e.target, res.code, { encoding: 'utf-8' });
        } else {
          context.log('deploy', task, `copying ${fspath.basename(e.source)} to ${fspath.relative(opts.targetRoot, e.target)}`)
          await fsp.copyFile(e.source, e.target);
        }
      }));
      context.log('deploy', task, 'done copying dependencies');
    }
  }
}

export class PolymerProject {
  sourceRoot: string;
  targetRoot: string;
  buildRoot: string;
  cwd: string;
  application: boolean;
  taskName = 'dopees-polymer';
  constructor(config: Options) {
    this.cwd = config.cwd || process.cwd();
    this.buildRoot = toAbsolutePath(config.buildRoot || './.build', this.cwd);
    this.sourceRoot = toAbsolutePath(config.sourceRoot, this.cwd);
    this.targetRoot = toAbsolutePath(config.targetRoot, this.cwd);
    this.application = config.application !== false;
  }
  private async getTargets() {
    const targets : Target[] = [];
    const traverse = async (subpath: string) => {
      const names = await fsp.readdir(fspath.join(this.sourceRoot, subpath));
      for (const name of names) {
        const sourcePath = fspath.normalize(fspath.join(this.sourceRoot, subpath, name));
        const stats = await fsp.stat(sourcePath).catch(() => null);
        if (stats) {
          if (stats.isDirectory()) {
            await traverse(fspath.normalize(fspath.join(subpath, name)));
          } else if (sourcePath.endsWith('.ts') && !sourcePath.endsWith('.d.ts')) {
            const targetPath = fspath.normalize(
              fspath.join(
                this.targetRoot,
                fspath.relative(this.sourceRoot, sourcePath)
              )
            ).replace(/\.ts$/, '.js');
            targets.push({ path: targetPath, base: this.cwd });
          }
        }
      }
    };
    await traverse('.');
    return targets;
  }
  createExecutor(): Executor {
    const pugSourceResolver = ReversePathResolver.from({
      sourceRoot: fspath.relative(this.cwd, this.sourceRoot),
      targetRoot: fspath.relative(this.cwd, this.buildRoot),
      sourceExt: 'pug',
      targetExt: 'html'
    });
    const executors = [
      sass({
        sourceRoot: fspath.relative(this.cwd, this.sourceRoot),
        targetRoot: fspath.relative(this.cwd, this.buildRoot),
        sourceExt: 'scss',
        targetExt: 'css',
        outputStyle: 'compressed'
      }),
      pug({
        inlineCss: true,
        targetRoot: fspath.relative(this.cwd, this.buildRoot),
        sourceResolver: (path: string, base?: string) => {
          const source = pugSourceResolver(path, base);
          if (!source) {
            throw new Error(`unable to resolve source for ${path} (base = ${base})`);
          }
          return source;
        }
      }),
      dopees({
        sourceRoot: fspath.relative(this.cwd, this.sourceRoot),
        buildRoot:  fspath.relative(this.cwd, this.buildRoot),
        targetRoot: fspath.relative(this.cwd, this.targetRoot),
        saveAllDependencies: true,
        allDependenciesKey: 'dopees.polymer.dependencies',
        updateExternalImports: this.application
      }),
      async (task: Task, context: Context) => {
        if (task.name instanceof LogicalName && task.name.name === this.taskName) {
          const targets = await this.getTargets();
          await Promise.all(targets.map(target => context.execute(Task.file(target.path, target.base))));
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
    return Executors.combine(executors);
  }
}