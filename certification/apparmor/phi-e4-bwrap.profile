abi <abi/4.0>,
include <tunables/global>

# Ubuntu 24.04's unconfined profile mode preserves ordinary DAC while allowing
# only this executable to create the user namespace used by Bubblewrap.
# The payload is separately confined by Bubblewrap with --disable-userns.
profile phi-e4-bwrap /home/runner/work/_temp/phi-e4-tools/usr/bin/bwrap flags=(unconfined) {
  userns,
}
