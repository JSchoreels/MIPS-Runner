# MIPS Runner

Run, debug, and explore MIPS assembly directly in VS Code. MIPS Runner includes the SPIM simulator as WebAssembly, so you do not need to install MARS or Java.

## See it in action

### Step through execution

Watch registers and memory change as the program runs. **Last change** shows the source line that most recently changed each value.

![Step-by-step execution: a program adds two values and stores the result in memory](media/demos/step-through.gif)

### Follow pointers

Select a register or memory address to visualize a path through the stack and data segments. These animations use the MIPS Runner simulator and view; the source code on the left is shown in a separate preview.

![Following pointers from the stack through value_ptr to the values array](media/demos/pointer-tracing.gif)

The program used in these demonstrations is available in [examples/pointer-chain.s](examples/pointer-chain.s).

## Installation

Install **MIPS Runner** by **Jisko** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Jisko.mips-runner), or search for it in the VS Code **Extensions** view.

To install a VSIX downloaded from GitHub:

1. Download the `.vsix` file for the desired version from the [GitHub releases](https://github.com/JSchoreels/MIPS-Runner/releases).
2. In desktop VS Code, open the **Extensions** view, select **…**, and choose **Install from VSIX…**.
3. Select the downloaded file and reload VS Code if needed.
4. Open a MIPS file; MIPS Runner loads it automatically by default.

If you have installed a development version named `local.mips-runner`, uninstall it before installing `Jisko.mips-runner` so both extensions are not active at the same time.

## Developing the extension

1. Open this folder in VS Code.
2. Press **F5** to launch an Extension Development Host window.
3. In that window, open a MIPS file such as `examples/pointers.s`.
4. MIPS Runner automatically loads the active file. Use **Step** or **Run** in the panel to execute it.

MIPS Runner uses the current editor contents, including unsaved changes. Editing the file pauses execution. **Run**, **Step**, or **Reset** then assembles the updated source and restarts the program; VS Code breakpoints are preserved.

Files ending in `.s`, `.asm`, and `.mips` use MIPS syntax highlighting. If another extension handles the same file type, select **MIPS** from the language selector at the bottom right of the editor.

When a MIPS file becomes active, the extension loads it automatically by default. The **MIPS Runner: Open Behavior** setting also offers `ask` (offer to load the file) and `manual` (use the load command). A dismissed prompt is not shown again while that file remains open. Returning to the already loaded file does not reset it; switching to another MIPS file loads that file instead.

## Usage

- Open a MIPS file and press **F5** to start it with **Run and Debug**; choose **MIPS Runner** if VS Code asks. The active file is assembled automatically. Set breakpoints in the editor gutter: the debug controls and memory map share the same simulator, and gutter breakpoints also work with **Run** in the MIPS Runner panel.
- Use **Run Without Debugging** to run the active file without stopping at breakpoints. Output appears in both the Debug Console and MIPS Runner.
- **Step Over** and **Step Into** advance by one machine instruction. **Step Out**, conditional breakpoints, and logpoints are not yet supported. If the source changes during a debug session, start debugging again to assemble the updated version.
- To move MIPS Runner to the right, use **View: Toggle Secondary Side Bar Visibility**, then drag the **MIPS Runner** tab into that sidebar. Drag it back to the bottom panel to restore its original position. Execution and breakpoints are preserved when moving the view.
- Filter the register list with **All registers**, **Used in code**, or **Accessed during execution**. The source filter includes registers mentioned in instructions, excluding comments and strings. The execution filter uses simulator-tracked reads and writes, including system calls, and resets after **Reset** or reassembly. The list scrolls when needed.
- Add a register such as `$t0`, `$s1`, or `$8`, or add `PC`, to VS Code's **Watch** section to inspect its value while debugging is paused. **Run** and **Step** in MIPS Runner start a debug session when needed without resetting the current program state. Arithmetic expressions are not yet supported.
- Registers, the **data** segment, and the **stack** remain visible together in the memory map. Select a register containing an address in either segment to highlight the corresponding word and follow possible pointers. Visible links are drawn in the panel; the summary retains the full path even when some addresses are off screen.
- In the loaded source file, click a register or data label to highlight it in the panel. Conversely, click a register or memory address in the panel to highlight its source references. Numeric register aliases are recognized. For memory, source highlighting uses only labels resolved to that exact address.
- Click a memory value that looks like an address to follow its path, or click an address in the summary to show it in its segment. A path stops at an ordinary value, a cycle, an unaligned address, or after eight words. An unaligned address is shown within its containing word without treating it as a complete word.
- The **Address** fields accept hexadecimal addresses and display 32-bit words starting at the corresponding aligned address. Register and memory values are shown in hexadecimal followed by signed decimal in parentheses, for example `0x0000000c (12)`. **Follow $sp** resumes tracking the stack pointer.
- Changed values are highlighted after a step. The **Last change** column identifies the last source line that actually changed each register or memory word, including during **Run**. Hover over the line number to see the instruction, then click the register, address, or line number to find it in the editor. A dash means no change has been recorded since assembly; writing the same value does not replace the previous change. Initialization and the startup routine are excluded. **Reset** and reassembly clear this history.
- The next instruction to execute is highlighted in the editor with an arrow in the gutter. The highlight disappears when the source changes or execution finishes. A step executes one machine instruction, so a pseudo-instruction may remain highlighted for several steps. At assembly time, the usual SPIM startup routine runs up to `main` before the first step.
- Hover over a supported instruction to see its purpose, operand format, and a link to the SPIM manual. Operand names in the tooltip are parameter examples, not register names to enter literally.
- As you type, SPIM validates the syntax of the MIPS file and reports errors in the editor and **Problems** view. Validation does not affect the current execution state or require the simulator panel to be open.
- **Reset** restarts execution while preserving VS Code breakpoints.
- For a program that reads standard input, enter the lines under **Standard input**, then click **Reset** before running. Program output and simulator messages appear under **Output and SPIM log**.

## Current limitations

- This version supports desktop VS Code. VS Code for the Web is not yet supported.
- Hover documentation covers common MIPS instructions and pseudo-instructions, not every SPIM instruction. The SPIM-based validator generally reports the first syntax error, but does not catch every runtime issue or undefined label.
- Breakpoints apply only to the loaded MIPS file and must be placed on a line containing an instruction. Conditional breakpoints, logpoints, and **Step Out** are not yet supported.
- Standard input must be prepared in advance; interactive input during execution is not yet supported.
- The runtime uses a virtual file system separate from the project files. File system calls do not access the VS Code project folder directly.
- The current SPIM build exposes a limited view of the stack. If the stack grows beyond that view, the extension hides stack values and shows a warning rather than displaying potentially incorrect data.
- Register and memory values are treated as possible pointers when they fall within a displayable segment. A numeric value can resemble an address without being an intended pointer. A data label selected in the editor is displayed with its address, but labels are not automatically shown for every memory word.

## Engine and provenance

The `vendor/spim` directory contains SPIM code from JsSpim, revision `64ddfacb70ccd5a63469d34a76eda109d5a820d2`, modified to record register reads and writes and the last instruction that changed a register or memory word. The included WebAssembly was rebuilt from these sources with Emscripten 3.1.64; the Makefile supports rebuilding with Emscripten, flex, and bison. The extension requires no build step or neighboring repository to run. License notices are available in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The project does not yet have its own license. The extension identifier is `Jisko.mips-runner`.
