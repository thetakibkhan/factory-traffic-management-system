import type { SignalCommand } from "../../domain/traffic/types.js";

export interface ControllerPort {
  dispatch(command: SignalCommand): Promise<void>;
  requestSnapshot(junctionId: string): Promise<void>;
}
