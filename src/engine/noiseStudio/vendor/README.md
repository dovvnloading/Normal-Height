# Vendored FastNoiseLite

`FastNoiseLite.ts` is byte-for-byte upstream source from:

<https://raw.githubusercontent.com/Auburn/FastNoiseLite/785f37a9ad76e283586a379675085f2063ae03f7/JavaScript/src/FastNoiseLite.ts>

SHA-256: `67c13e35897c5cb3a8ea19bfa39ab9ec240bb887c7c79a58102488c15bdc1aaf`

Do not run the application formatter over this file. Keep the original MIT
header and source intact; wrappers and mathematical extensions belong in the
parent directory. See `THIRD_PARTY_NOTICES.md` at the repository root for the
redistribution notice.

The Studio wrapper sets frequency to 1 and leaves the vendor's own fractal mode
disabled. It calls actual OpenSimplex2, OpenSimplex2S, Perlin, Hermite value, and
cubic value kernels. All Studio transforms, octave composition, derivative
feedback, warping, output remapping, and seamless periodization are independent
modules. Existing project `Noise` implementations do not import this vendor.

When deliberately upgrading the pinned implementation, update the source URL,
hash and notice together, inspect numerical changes, and rerun the fixed
reference vectors, analytic-derivative comparison, and saved-project compatibility
tests. Do not silently change saved Studio v3 recipe output.
