/* SPIM S20 MIPS simulator.
   Terminal interface for SPIM simulator.

   Copyright (c) 1990-2015, James R. Larus.
   All rights reserved.

   Redistribution and use in source and binary forms, with or without modification,
   are permitted provided that the following conditions are met:

   Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.

   Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation and/or
   other materials provided with the distribution.

   Neither the name of the James R. Larus nor the names of its contributors may be
   used to endorse or promote products derived from this software without specific
   prior written permission.

   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
   AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
   IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
   ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
   LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
   CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE
   GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
   HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
   LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
   OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

#include "emscripten/bind.h"
#include "emscripten/val.h"

#include <unistd.h>
#include <stdio.h>
#include <stdarg.h>
#include <algorithm>
#include <unordered_map>

#include "spim.h"
#include "string-stream.h"
#include "spim-utils.h"
#include "inst.h"
#include "reg.h"
#include "register-access.h"
#include "change-history.h"
#include "mem.h"
#include "data.h"
#include "version.h"

using namespace emscripten;

bool bare_machine;        /* => simulate bare machine */
bool delayed_branches;        /* => simulate delayed branches */
bool delayed_loads;        /* => simulate delayed loads */
bool accept_pseudo_insts = true;    /* => parse pseudo instructions  */
bool quiet;            /* => no warning messages */
char *exception_file_name;
port message_out, console_out, console_in;
bool mapped_io;            /* => activate memory-mapped IO */
int spim_return_value;        /* Value returned when spim exits */

static str_stream ss;
static unsigned int register_last_changed[32] = {};
static std::unordered_map<uint32_t, uint32_t> memory_last_changed;
static bool tracking_changes = false;
static uint32_t tracked_instruction = 0;

void clearChangeHistory() {
  std::fill(register_last_changed, register_last_changed + 32, 0);
  memory_last_changed.clear();
}

bool change_history_active() { return tracking_changes; }

void record_memory_change(uint32_t address) {
  if (tracking_changes) memory_last_changed[address & ~uint32_t(3)] = tracked_instruction;
}

void record_memory_pointer_change(const void* pointer, unsigned char old_value, unsigned char new_value) {
  if (!tracking_changes || old_value == new_value) return;
  const uintptr_t value = reinterpret_cast<uintptr_t>(pointer);
  const uintptr_t data_offset = value - reinterpret_cast<uintptr_t>(data_seg);
  const uintptr_t stack_offset = value - reinterpret_cast<uintptr_t>(stack_seg);
  if (data_offset < data_top - DATA_BOT) record_memory_change(DATA_BOT + data_offset);
  else if (stack_offset < STACK_TOP - stack_bot) record_memory_change(stack_bot + stack_offset);
}

size_t traceable_memory_bytes(uint32_t address, size_t requested) {
  if (address >= DATA_BOT && address < data_top) return std::min(requested, size_t(data_top - address));
  if (address >= stack_bot && address < STACK_TOP) return std::min(requested, size_t(STACK_TOP - address));
  return 0;
}

unsigned int getMemoryLastChange(unsigned int address) {
  const auto found = memory_last_changed.find(address & ~uint32_t(3));
  return found == memory_last_changed.end() ? 0 : found->second;
}

val getRegisterLastChanges() { return val(typed_memory_view(32, register_last_changed)); }

void init() {
  clearChangeHistory();
  error("Based on <a href='http://spimsimulator.sourceforge.net/'>SPIM</a> %s "
        "by <a href='https://people.epfl.ch/james.larus'>James Larus</a>.\n",
        SPIM_VERSION);

  initialize_world(DEFAULT_EXCEPTION_HANDLER, false);
  initialize_run_stack(0, nullptr);
  read_assembly_file("input.s");
  PC = starting_address();
}


unsigned int register_access_masks[2] = {0, 0};

int step(int step_size, bool cont_bkpt) {
  register_access_masks[0] = register_access_masks[1] = 0;
  mem_addr addr = PC == 0 ? starting_address() : PC;
  if (step_size == 0) step_size = DEFAULT_RUN_STEPS;

  reg_word before[32];
  std::copy(R, R + 32, before);
  tracking_changes = true;
  tracked_instruction = addr;
  bool continuable, bp_encountered;
  bp_encountered = run_program(addr, step_size, false, cont_bkpt, &continuable);
  tracking_changes = false;
  if (!bp_encountered)
    for (unsigned int index = 0; index < 32; ++index)
      if (R[index] != before[index]) register_last_changed[index] = addr;

  if (!continuable) { // finished
    printf("\n"); // to flush output
    error("Execution finished\n");
    return 0;
  }

  if (bp_encountered) {
    error("Breakpoint encountered at 0x%08x\n", PC);
    return -1;
  }

  return 1;
}


std::string getUserText() {
  ss_clear(&ss);
  format_insts(&ss, TEXT_BOT, text_top);
  return std::string(ss_to_string(&ss));
}

std::string getKernelText() {
  ss_clear(&ss);
  format_insts(&ss, K_TEXT_BOT, k_text_top);
  return std::string(ss_to_string(&ss));
}

val getStack() { return val(typed_memory_view(STACK_LIMIT / 16, (unsigned int *) stack_seg)); }
val getUserData() { return val(typed_memory_view(data_top - DATA_BOT, (unsigned int *) data_seg)); }
val getKernelData() { return val(typed_memory_view(k_data_top - K_DATA_BOT, (unsigned int *) k_data_seg)); }
val getGeneralRegVals() { return val(typed_memory_view(32, (unsigned int *) R)); }
val getRegisterAccesses() { return val(typed_memory_view(2, register_access_masks)); }
val getFloatRegVals() { return val(typed_memory_view(32, (float *) FPR)); }
val getDoubleRegVals() { return val(typed_memory_view(16, (double *) FPR)); }

val getSpecialRegVals() {
  static unsigned int specialRegs[12];
  specialRegs[0] = PC;
  specialRegs[1] = CP0_EPC;
  specialRegs[2] = CP0_Cause;
  specialRegs[3] = CP0_BadVAddr;
  specialRegs[4] = CP0_Status;
  specialRegs[5] = HI;
  specialRegs[6] = LO;
  specialRegs[7] = FIR;
  specialRegs[8] = FCSR;
  specialRegs[9] = FCCR;
  specialRegs[10] = FEXR;
  specialRegs[11] = FENR;

  return val(typed_memory_view(12, specialRegs));
}

EMSCRIPTEN_BINDINGS(init) { function("init", &init); }
EMSCRIPTEN_BINDINGS(step) { function("step", &step); }
EMSCRIPTEN_BINDINGS(getUserText) { function("getUserText", &getUserText); }
EMSCRIPTEN_BINDINGS(getKernelText) { function("getKernelText", &getKernelText); }
EMSCRIPTEN_BINDINGS(getStack) { function("getStack", &getStack); }
EMSCRIPTEN_BINDINGS(getUserData) { function("getUserData", &getUserData); }
EMSCRIPTEN_BINDINGS(getKernelData) { function("getKernelData", &getKernelData); }
EMSCRIPTEN_BINDINGS(getGeneralRegVals) { function("getGeneralRegVals", &getGeneralRegVals); }
EMSCRIPTEN_BINDINGS(getRegisterAccesses) { function("getRegisterAccesses", &getRegisterAccesses); }
EMSCRIPTEN_BINDINGS(clearChangeHistory) { function("clearChangeHistory", &clearChangeHistory); }
EMSCRIPTEN_BINDINGS(getMemoryLastChange) { function("getMemoryLastChange", &getMemoryLastChange); }
EMSCRIPTEN_BINDINGS(getRegisterLastChanges) { function("getRegisterLastChanges", &getRegisterLastChanges); }
EMSCRIPTEN_BINDINGS(getFloatRegVals) { function("getFloatRegVals", &getFloatRegVals); }
EMSCRIPTEN_BINDINGS(getDoubleRegVals) { function("getDoubleRegVals", &getDoubleRegVals); }
EMSCRIPTEN_BINDINGS(getSpecialRegVals) { function("getSpecialRegVals", &getSpecialRegVals); }
EMSCRIPTEN_BINDINGS(delete_breakpoint) { function("deleteBreakpoint", &delete_breakpoint); }
EMSCRIPTEN_BINDINGS(add_breakpoint) { function("addBreakpoint", &add_breakpoint); }

/* Print an error message. */

void error(char *fmt, ...) {
  va_list args;
  va_start(args, fmt);
  vfprintf(stderr, fmt, args);
  va_end(args);
}

/* Print the error message then exit. */

void fatal_error(char *fmt, ...) {
  va_list args;
  va_start(args, fmt);
  fmt = va_arg(args, char *);
  vfprintf(stderr, fmt, args);
  exit(-1);
}

/* Print an error message and return to top level. */

void run_error(char *fmt, ...) {
  va_list args;
  va_start(args, fmt);
  vfprintf(stderr, fmt, args);
  va_end(args);
}

/* IO facilities: */

void write_output(port fp, char *fmt, ...) {
  va_list args;
  va_start(args, fmt);
  vfprintf(stdout, fmt, args);
  fflush(stdout);
  va_end(args);
}

/* Simulate the semantics of fgets (not gets) on Unix file. */

void read_input(char *str, int str_size) {
  char *ptr;
  ptr = str;
  while (1 < str_size) /* Reserve space for null */
  {
    char buf[1];
    if (read((int) console_in.i, buf, 1) <= 0) /* Not in raw mode! */
      break;

    record_memory_pointer_change(ptr, static_cast<unsigned char>(*ptr), static_cast<unsigned char>(buf[0]));
    *ptr++ = buf[0];
    str_size -= 1;

    if (buf[0] == '\n') break;
  }

  if (0 < str_size) {
    record_memory_pointer_change(ptr, static_cast<unsigned char>(*ptr), 0);
    *ptr = '\0'; /* Null terminate input */
  }
}

int console_input_available() {
  return 0;
}

char get_console_char() {
  char buf;
  read(0, &buf, 1);
  return (buf);
}

void put_console_char(char c) {
  putc(c, stdout);
  fflush(stdout);
}