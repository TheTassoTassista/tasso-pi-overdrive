---
name: cpp
description: Work on C and C++ code with build-system, ownership, ABI, diagnostics, and test awareness. Use for C/C++, CMake, Make, clangd, sanitizers, or native debugging.
---
# C and C++

Inspect the compiler standard, build system, warnings, and ownership conventions. Use clangd definitions/references before broad reads. Keep ABI/API changes explicit.

Check lifetimes, bounds, integer conversions, concurrency, exception safety, undefined behavior, and error propagation. Prefer RAII and existing project abstractions over new wrappers.

Build the narrowest target. Run relevant tests and, when supported and proportional to risk, ASan/UBSan or the project's sanitizer preset. Never claim portability from one compiler run alone.
