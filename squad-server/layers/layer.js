export default class Layer {
  constructor(data) {
    this.name = data.Name;
    this.classname = data.levelName;
    this.layerid = data.rawName;
    this.map = {
      name: data.mapName
    };
    this.gamemode = data.gamemode;
    this.gamemodeType = data.type;
    this.version = data.layerVersion;
    this.size = data.mapSize;
    this.sizeType = data.mapSizeType;
    this.numberOfCapturePoints = parseInt(data.capturePoints);
    this.lighting = {
      name: data.lighting,
      classname: data.lightingLevel
    };
    this.teams = [];
    for (const t of ['team1', 'team2']) {
      const team = data[t] ?? {};
      const vehicles = team.vehicles ?? [];

      this.teams.push({
        faction: team.faction,
        name: team.teamSetupName,
        tickets: team.tickets,
        commander: team.commander,
        vehicles: vehicles.map((vehicle) => ({
          name: vehicle.type,
          classname: vehicle.rawType ?? vehicle.classNames?.[0],
          classNames: vehicle.classNames ?? (vehicle.rawType ? [vehicle.rawType] : []),
          count: vehicle.count,
          spawnDelay: vehicle.delay,
          respawnDelay: vehicle.respawnTime
        })),
        numberOfTanks: vehicles.filter((vehicle) => {
          return /_tank/i.test(vehicle.icon ?? '');
        }).length,
        numberOfHelicopters: vehicles.filter((vehicle) => {
          return /helo/i.test(vehicle.icon ?? '');
        }).length
      });
    }
  }
}
