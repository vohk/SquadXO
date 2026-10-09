import type { ServerInformationEvent } from '../domain/events.js';
import type { PlayerSnapshotChanges } from '../domain/server-state.js';
import type { LayerInformation } from '../rcon/squad-protocol.js';
import type { StateRefreshHooks } from '../server/state-refresher.js';
import type { LegacyLayer } from './legacy-layer-catalog.js';
import type { LegacyServerHost } from './legacy-server-facade.js';

export interface LegacyLayerLookup {
  byInformation(information: LayerInformation): Promise<LegacyLayer | undefined>;
}

export function createLegacyStateRefreshHooks(
  events: LegacyServerHost,
  layers: LegacyLayerLookup
): StateRefreshHooks {
  return {
    players: (changes: PlayerSnapshotChanges) => {
      for (const change of changes.teamChanged) {
        events.publish({ name: 'PLAYER_TEAM_CHANGE', data: change });
      }
      for (const change of changes.squadChanged) {
        events.publish({ name: 'PLAYER_SQUAD_CHANGE', data: change });
      }
      events.publish({ name: 'UPDATED_PLAYER_INFORMATION', data: {} });
    },
    squads: () => events.publish({ name: 'UPDATED_SQUAD_INFORMATION', data: {} }),
    layers: async (current: LayerInformation, next: LayerInformation) => {
      const [legacyCurrent, legacyNext] = await Promise.all([
        layers.byInformation(current),
        layers.byInformation(next)
      ]);
      events.setLegacyLayers(legacyCurrent, legacyNext);
      events.publish({ name: 'UPDATED_LAYER_INFORMATION', data: {} });
    },
    serverInfo: (information: ServerInformationEvent) => {
      events.publish({ name: 'UPDATED_A2S_INFORMATION', data: information });
      events.publish({ name: 'UPDATED_SERVER_INFORMATION', data: information });
    }
  };
}
