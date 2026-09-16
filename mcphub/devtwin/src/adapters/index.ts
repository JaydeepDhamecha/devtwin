/**
 * Ecosystem adapter registry.
 *
 * Adding a new language: implement `EcosystemAdapter` in a new module and add
 * an instance to `ADAPTERS` below.
 */

import { EcosystemAdapter } from './base.js';
import { DotnetAdapter } from './dotnet.js';
import { GenericAdapter } from './generic.js';
import { GoAdapter } from './go.js';
import { JvmAdapter } from './jvm.js';
import { NodeAdapter } from './node.js';
import { PhpAdapter } from './php.js';
import { PythonAdapter } from './python.js';
import { RubyAdapter } from './ruby.js';
import { RustAdapter } from './rust.js';
import { SwiftAdapter } from './swift.js';

// Order matters only for tie-breaking display; detection confidence drives
// which ecosystem is "primary".
export const ADAPTERS: EcosystemAdapter[] = [
  new PythonAdapter(),
  new NodeAdapter(),
  new JvmAdapter(),
  new GoAdapter(),
  new RustAdapter(),
  new DotnetAdapter(),
  new SwiftAdapter(),
  new RubyAdapter(),
  new PhpAdapter(),
];

export const GENERIC_ADAPTER = new GenericAdapter();

export { EcosystemAdapter };
