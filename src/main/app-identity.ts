/** Source runs must never register Windows shortcuts under the installed app ID. */
export function resolveAppIdentity(version: string, packaged: boolean) {
  const development = !packaged || version.endsWith("-dev");
  return {
    development,
    name: development ? "Passport-dev" : "Passport",
    appId: development ? "io.passport.desktop.dev" : "io.passport.desktop",
    version: development ? version.replace(/-dev$/, "") + "-dev" : version,
  };
}
