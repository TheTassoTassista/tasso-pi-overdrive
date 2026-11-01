// Disposable Pi RPC fixture: fail only the verification child before it runs checks.
if (process.env.PI_OVERDRIVE_VERIFY_PROCESS_FAULT === "1" && process.argv[1]?.endsWith("/scripts/verify-project.mjs")) {
  process.exit(76);
}
