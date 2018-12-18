import { Node } from '@babel/types';

export interface MatchPatternFunction {
  (filename: string | void, context: { callee: { name: string } } | void, envName: string): boolean
}

export type MatchPattern = string | RegExp | MatchPatternFunction;

export type EntryTarget = string | {} | Function;

export type EntryOptions = undefined | {} | false;

export type PluginEntry = EntryTarget | [ EntryTarget, EntryOptions ] | [EntryTarget, EntryOptions, string];

export type PresetEntry = EntryTarget | [ EntryTarget, EntryOptions ] | [EntryTarget, EntryOptions, string];

export interface Options {
  cwd?: string;
  filename?: string;
  filenameRelative?: string;
  code?: boolean;
  ast?: boolean;
  root?: string;
  rootMode?: 'root' | 'upward' | 'upward-optional';
  envName?: string;
  configFile?: string | boolean;
  babelrc?: boolean;
  babelrcRoots?: boolean | MatchPattern | Array<MatchPattern>;
  plugins?: Array<PluginEntry>;
  presets?: Array<PresetEntry>;
  passPerPreset?: boolean;
  inputSourceMap?: boolean;
  sourceMaps?: boolean | 'inline' | 'both';
  sourceFileName?: string;
  sourceRoot?: string;
  parserOpts?: any;
  // TODO: other...
}

export function transformAsync(code: string, options?: Options): Promise<{ code: string, map?: string, ast: Node }>
export function transformFromAstAsync(ast: Node, code?: string, options?: Options): Promise<{ code: string, map?: string, ast: Node }>
export function parseAsync(code: string, options?: Options): Promise<Node>;