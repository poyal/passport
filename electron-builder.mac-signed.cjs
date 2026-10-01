const base = require("./package.json").build;

// Keep a fixed signer across updates. Never inherit the preview's ad-hoc identity.
const certificate = process.env.CSC_NAME?.trim();
if (
  !certificate ||
  !/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(certificate)
) {
  throw new Error(
    "Set CSC_NAME to the full Developer ID Application certificate name " +
      "shown by `security find-identity -v -p codesigning`. " +
      "A signed build cannot use an ad-hoc identity. " +
      "See docs/distribution.md.",
  );
}

module.exports = {
  ...base,
  extends: null,
  forceCodeSigning: true,
  mac: {
    ...base.mac,
    type: "distribution",
    // electron-builder adds the certificate type itself.
    identity: certificate.replace(/^Developer ID Application: /, ""),
  },
};
