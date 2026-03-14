// Shared interface for WebVisu controllers (Playwright-based and protocol-based)

export interface LightStatus {
  id: string;
  name: string;
  isOn: boolean;
  isOn2?: boolean;
}

export interface CoordinateMarkerSpec {
  x: number;
  y: number;
  type: 'down' | 'up' | 'click';
  label?: string;
}

export interface IWebVisuController {
  initialize(): Promise<void>;
  close(): Promise<void>;
  selectLightSwitch(lightId: string): Promise<void>;
  toggleLight(lightId: string, functionNumber?: 1 | 2): Promise<void>;
  getLightStatus(lightId: string, options?: { background?: boolean }): Promise<LightStatus>;
  getAllLights(): Promise<LightStatus[]>;
  navigateToTab(tabName: string): Promise<void>;
  takeScreenshot(): Promise<Buffer>;
  getRenderedUiImage?(markers?: CoordinateMarkerSpec[]): Promise<Buffer | null>;
  isConnected(): Promise<boolean>;
  getPendingOperationCount(): number;
  resetDropdownState(): void;
}
