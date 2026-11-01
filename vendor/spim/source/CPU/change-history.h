#ifndef MIPS_RUNNER_CHANGE_HISTORY_H
#define MIPS_RUNNER_CHANGE_HISTORY_H

#include <stddef.h>
#include <stdint.h>

// The active instruction owns all changes recorded while SPIM executes it.
bool change_history_active();
void record_memory_change(uint32_t address);
void record_memory_pointer_change(const void* pointer, unsigned char old_value, unsigned char new_value);
size_t traceable_memory_bytes(uint32_t address, size_t requested);

#endif
