#ifndef MIPS_RUNNER_REGISTER_ACCESS_H
#define MIPS_RUNNER_REGISTER_ACCESS_H

// The masks are cleared at the start of each simulator step. They describe
// reads and writes made by the instruction, including its SPIM syscall.
extern unsigned int register_access_masks[2];

class RegisterAccess {
public:
  explicit RegisterAccess(int index) : index_(index) {}
  RegisterAccess(const RegisterAccess&) = default;

  operator reg_word() const {
    register_access_masks[0] |= 1u << index_;
    return R[index_];
  }

  RegisterAccess& operator=(reg_word value) {
    register_access_masks[1] |= 1u << index_;
    R[index_] = value;
    return *this;
  }

  RegisterAccess& operator=(const RegisterAccess& other) {
    return *this = static_cast<reg_word>(other);
  }

  // SPIM's load implementation writes through a register pointer.
  reg_word* operator&() const {
    register_access_masks[1] |= 1u << index_;
    return &R[index_];
  }

private:
  int index_;
};

class TrackedRegisters {
public:
  RegisterAccess operator[](int index) const { return RegisterAccess(index); }
  reg_word& untracked(int index) const { return R[index]; }
};

#endif
