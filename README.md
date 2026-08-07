# Empathy

Empathy is an embeddable C runtime for data-driven branching logic. A host application describes
its data model, loads validated Empathy bytecode, binds native data tables, and drives execution,
predicate matching, and yields through a small public API.

The project is currently `1.0.0-dev`. The public API and bytecode tooling are still evolving; the
current bytecode format is version `1.0`.

## Core model

An Empathy application is built from four kinds of objects:

- `Empathy_Instance` owns every other runtime object.
- `Empathy_ProgramLayout` describes atom domains, host parameters, and yield contracts.
- `Empathy_Program` combines a layout, bytecode, and one or more entry points.
- `Empathy_Machine` binds a program to host data and holds execution, predicate, and yield stacks.

A typical execution flow is:

1. Create an instance.
2. Create a program layout.
3. Create a program from validated bytecode and entry points.
4. Create a machine and bind the program.
5. Bind the required host parameter tables.
6. Optionally call `empathyMatch` to select an entry point by predicate.
7. Bind an entry point and call `empathyRun` until execution ends or yields.
8. Destroy the machine, program, layout, and instance in that order.

Program layouts and programs copy their descriptors and bytecode during creation. Bound parameter
tables remain owned by the host and must stay valid while a machine uses them. A layout must remain
alive while programs and machines refer to it.

### Atoms

An `Empathy_Atom` is a pair of `uint32_t` values: `type` and `value`. Atom types are application
defined. A program layout declares every accepted atom type together with its inclusive value range,
allowing bytecode validation without embedding application strings or objects into the runtime.

For example, a narrative host can use separate atom types for lines, characters, and choices while
keeping the actual text in application-owned arrays or asset databases.

### Parameters

A parameter declaration maps a bytecode parameter index to:

- a host parameter-table index;
- a byte offset within that table;
- an `Empathy_ValueType`;
- read, write, or read/write access.

The host binds table pointers with `empathyBindParameterTable`. Bytecode uses `LOAD` and `STORE`
with zero-based parameter indices; the runtime performs type, access, and bounds checks.

### Yields

A yield declaration describes the values required to resume that yield. Bytecode prepares the yield
stack and executes `YIELD` with a zero-based yield index. `empathyRun` then returns
`EMPATHY_EXECUTION_YIELD`.

While the machine is yielded, the host can:

- inspect the yield index with `empathyGetYieldIndex`;
- inspect or consume yielded values with `empathyGetYieldStackSize`, `empathyYieldStackPeek`, and
  `empathyYieldStackPop`;
- push response values with `empathyYieldStackPush`.

Calling `empathyRun` again validates the response values against the declared resume types before
continuing execution.

### Entry points and predicates

Every `Empathy_EntryPointDesc` contains a required execution offset and an optional predicate
offset. Use `EMPATHY_PROGRAM_OFFSET_NONE` when an entry point has no predicate.

`empathyMatch` evaluates predicate-bearing entry points and returns the value produced by each match
together with its entry-point index. The host can then bind a selected entry point with
`empathyBindProgramEntryPoint` and execute it with `empathyRun`.

## Bytecode v1

The source of truth for the current bytecode ABI is
[`spec/bytecode-v1.json`](spec/bytecode-v1.json). It defines:

- the bytecode major and minor version;
- byte order and instruction alignment;
- operand sizes;
- execution-mode bits;
- instruction names, opcode values, operands, and allowed modes.

The JSON specification controls the generated ABI tables, but the following encoding rules are
fixed parts of bytecode v1 rather than configurable format options.

### Instruction encoding

Bytecode is a contiguous sequence of byte-aligned instructions. Each instruction consists of a
one-byte opcode followed immediately by the operands declared for that opcode in the specification.
There is no padding between instructions.

All multi-byte operands use little-endian byte order:

| Operand | Size | Encoding |
| --- | ---: | --- |
| `u8`, `u16`, `u32`, `u64` | 1, 2, 4, 8 bytes | Unsigned binary integer |
| `i8`, `i16`, `i32`, `i64` | 1, 2, 4, 8 bytes | Two's-complement signed integer |
| `f32`, `f64` | 4, 8 bytes | IEEE 754 binary32 or binary64 |
| `atom` | 8 bytes | Atom type as `u32`, then atom value as `u32` |
| `parameter_index` | 4 bytes | Zero-based `u32` program-layout parameter index |
| `yield_index` | 4 bytes | Zero-based `u32` program-layout yield index |
| `program_offset` | 8 bytes | Absolute `u64` byte offset into the instruction stream |

A `program_offset` is measured from the first byte of the bytecode stream. It is never relative to
the current instruction and does not include an enclosing file or package header. Jump targets and
entry-point offsets must identify the opcode byte at an instruction boundary.

### Execution modes

Instructions may be valid in execution mode, predicate mode, or both. The current instruction
families are:

| Family | Modes |
| --- | --- |
| Constants, `LOAD`, stack operations, arithmetic, comparisons, jumps | Execution and predicate |
| `STORE`, yield-stack operations, `YIELD`, `END` | Execution only |
| `REJECT`, conditional rejects, `MATCH` | Predicate only |

The exact mode assignment for every opcode is authoritative in the JSON specification.

### Validation

Programs are validated when `empathyCreateProgram` is called.

The validator allocates one byte of metadata per bytecode byte and performs two linear passes:

1. Decode instruction boundaries, sizes, and allowed modes. An opcode byte stores its non-zero mode
   mask; operand bytes remain zero.
2. Validate instruction operands, atom ranges, parameter and yield indices, and jump targets using
   the boundary table.

After the instruction passes, every execution and predicate entry offset is checked for bounds,
instruction alignment, and a compatible mode. This keeps boundary lookup constant-time and overall
instruction-boundary processing linear in the bytecode size plus the number of entry points. Atom
operand validation additionally scans the atom types declared by the program layout.

The validator currently checks the mode of the instruction at each entry point, but it does not yet
propagate modes through the complete control-flow graph. Full reachable-path mode validation is a
future extension.

### Versioning and compatibility

`EMPATHY_BYTECODE_MAKE_VERSION(major, minor)` stores the major version in the upper 16 bits and the
minor version in the lower 16 bits. `Empathy_ProgramDesc.bytecode_version` must currently equal
`EMPATHY_BYTECODE_VERSION` exactly.

Within bytecode major version 1, existing opcode numbers and operand encodings must not be changed or
reused. An incompatible binary or semantic change requires a new major version.

## Generating bytecode ABI declarations

`tools/generate_bytecode.py` generates C ABI declarations, runtime lookup tables, and the Obsidian
plugin's TypeScript bytecode constants and low-level writer. It does not compile narrative source or
produce a program's bytecode stream.

Pass the specification path as the required positional argument:

```sh
python tools/generate_bytecode.py spec/bytecode-v1.json
```

Use `--check` to verify that generated regions are current without modifying files:

```sh
python tools/generate_bytecode.py spec/bytecode-v1.json --check
```

The generator updates marked regions in:

- `include/empathy.h`: bytecode version macros and `Empathy_BytecodeOpcode`;
- `src/impl/impl_bytecode.c`: instruction-size and instruction-mode tables.

It also generates the complete `plugins/obsidian/src/bytecode.ts` file. Constants come from the JSON
specification; the small writer body comes from `tools/bytecode_writer.ts.in`. `--check` verifies all
three outputs.

Generated regions contain a `Do not edit manually` notice. Change the JSON specification and rerun
the generator instead of editing those regions directly. The bytecode fields in
`Empathy_ProgramDesc` and the rest of the public API are maintained manually.

## Obsidian Canvas proof of concept

The deliberately small plugin under `plugins/obsidian/` compiles the active Canvas runtime graph
directly to an Empathy bytecode payload and a companion C/C++ header next to the `.canvas` file.

### Frozen POC baseline

Plugin version `0.0.3` targets and has been exercised with Obsidian Desktop `1.13.4`; the manifest is
desktop-only and compatibility with other Obsidian releases is not claimed. Its locked build uses
Obsidian API typings `1.13.1`—that package version is not the runtime application version. The
recorded build toolchain is Node.js `22.17.1` with npm `11.4.2`.

Known limitations are deliberate: the plugin depends on undocumented Canvas runtime objects,
accepts only its current metadata schema, and provides no migration or backward compatibility.
Standard Canvas cards outside the reachable story graph are ignored, so they can still be used for
notes. Only nodes reachable from an `ENTRY` are emitted. Choice options are ordered by Canvas edge
ID, and multiple entry points are ordered by their Canvas node ID. The five-button toolbar may be
clipped in an unusually narrow split pane; the background menu and commands remain available.

### Build and install

```sh
cd plugins/obsidian
npm ci
npm run verify
```

`npm run verify` runs the mocked Canvas compiler tests, performs a TypeScript check, and builds the
plugin. The individual `npm test`, `npm run typecheck`, and `npm run build` commands remain available.
Before freezing a release, also run the bytecode generator's `--check` command shown above from the
repository root; normal plugin builds do not require Python. Copy `plugins/obsidian/main.js`,
`plugins/obsidian/manifest.json`, and `plugins/obsidian/styles.css` into
`<vault>/.obsidian/plugins/empathy-canvas-poc/`, then reload Obsidian and enable **Empathy** under
**Settings -> Community plugins**.

With a Canvas open, use the five colored Empathy buttons in its bottom card toolbar to add an
**ENTRY**, **SAY**, **LINE**, **CHOICE**, or **END** at the viewport center. Precise placement remains
available by right-clicking the empty background and choosing the corresponding **Add Empathy**
action. The same actions are available in the command palette, and an existing text card can be
converted from its context menu. Every typed card has a persistent visual header. `SAY` additionally
has a separate character input; its native Canvas text editor contains only the dialogue.

A ready-to-open branching example using every node type is available at
`plugins/obsidian/examples/signal-tower-demo.canvas`.

The cards are stored as standard JSON Canvas text nodes with an `empathyKind` metadata field. `SAY`
also stores its character in `empathyCharacter`, keeping semantic fields out of the dialogue text:

| Node | Card text | Edges |
| --- | --- | --- |
| `ENTRY` | Empty (or an optional note) | Exactly one outgoing edge |
| `SAY` | Dialogue only; character is edited in the header | Exactly one outgoing edge |
| `LINE` | The complete line | Exactly one outgoing edge |
| `CHOICE` | Empty (or an optional note) | One or more labeled outgoing edges |
| `END` | Empty (or an optional note) | No outgoing edges |

Text-marker nodes and combined `Character\nDialogue` SAY payloads are not migrated or compiled;
converting an ordinary text card treats its text literally.

## Building

Empathy uses CMake 3.10 or newer. The runtime and tests are written in C; the samples require a C++17
compiler. Python 3 is needed only when regenerating bytecode ABI declarations.

Configure and build manually:

```sh
cmake -S . -B build -DEMPATHY_BUILD_SAMPLES=ON -DBUILD_TESTING=ON
cmake --build build --config Debug
```

Run the test suite:

```sh
ctest --test-dir build -C Debug --output-on-failure
```

Install the library and public header:

```sh
cmake --install build --config Release --prefix path/to/install
```

Useful CMake options and targets:

| Name | Purpose |
| --- | --- |
| `EMPATHY_BUILD_SAMPLES` | Build both samples; defaults to `ON` |
| `BUILD_TESTING` | Build and register CTest tests |
| `empathy` | Runtime library |
| `01_machine` | Parameter-binding sample |
| `02_narrative` | Interactive narrative sample |
| `bytecode_tests` | Build all bytecode test executables |

`CMakePresets.json` contains presets for Visual Studio, macOS Clang, and Emscripten. For example:

```sh
cmake --preset msvc2022-x64
cmake --build --preset build-msvc2022-x64-debug
```

On Windows and macOS the runtime is currently built as a shared library. The Emscripten build uses a
static library.

## Samples

[`samples/01_machine`](samples/01_machine) demonstrates the minimal runtime lifecycle, parameter
layout declarations, native table binding, and execution of directly embedded bytecode.

[`samples/02_narrative`](samples/02_narrative) demonstrates narrative flow with line, character, and
choice atoms; line, choice, and dialogue yields; host-provided choice responses; branching; and a
shared ending. All narrative data and bytecode are embedded directly in the sample.

## Tests

Bytecode tests are C executables under `tests/bytecode/src`, backed by the shared test library in
`tests/bytecode/common`:

- `test_bytecode_decode` covers scalar and atom operand decoding;
- `test_bytecode_entry_points` covers instruction-boundary and entry-mode validation;
- `test_bytecode_instruction_validation` covers malformed opcodes, operands, indices, atoms, and
  jump targets.

Tests use release-safe checks: Empathy API calls are evaluated separately, and test conditions remain
active when `NDEBUG` is defined.

## Repository layout

```text
include/             Public C API
src/                 Runtime implementation
spec/                Versioned bytecode ABI specifications
tools/               Bytecode ABI generator
plugins/obsidian/     Canvas compiler proof-of-concept plugin
samples/              Embedding and narrative examples
tests/bytecode/       Bytecode validation and decoding tests
```

## License

Empathy is available under the [MIT License](LICENSE).
