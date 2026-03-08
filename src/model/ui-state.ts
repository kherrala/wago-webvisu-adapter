import { uiCoordinates, lightSwitchList } from '../config';

export interface DropdownLabel {
  text: string;
  index: number;
  row: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export class UIState {
  // --- Tab ---
  activeTab = 'napit';

  // --- Dropdown logical state ---
  dropdownOpen = false;
  dropdownFirstVisible = 0;
  dropdownVisibleLabels: DropdownLabel[] = [];
  dropdownSelectedHeader: string | null = null;

  // --- Derived geometry ---
  get dropdownHandleCenterY(): number {
    return this.getDropdownScrollY(this.dropdownFirstVisible);
  }

  getDropdownScrollY(firstVisible: number): number {
    const topY = uiCoordinates.lightSwitches.scrollbar.thumbRange.topY;
    const bottomY = uiCoordinates.lightSwitches.scrollbar.thumbRange.bottomY;
    const maxFirstVisible = this.getDropdownMaxFirstVisible();
    if (maxFirstVisible <= 0 || firstVisible <= 0) return topY;
    if (firstVisible >= maxFirstVisible) return bottomY;
    return topY + (((bottomY - topY) * firstVisible) / maxFirstVisible);
  }

  getDropdownMaxFirstVisible(): number {
    return Math.max(0, lightSwitchList.length - uiCoordinates.lightSwitches.dropdownList.visibleItems);
  }

  isDropdownIndexVisible(index: number): boolean {
    const visibleItems = uiCoordinates.lightSwitches.dropdownList.visibleItems;
    return index >= this.dropdownFirstVisible && index < this.dropdownFirstVisible + visibleItems;
  }

  getTargetFirstVisible(index: number, preferredRow?: number): number {
    const visibleItems = uiCoordinates.lightSwitches.dropdownList.visibleItems;
    const maxFirstVisible = this.getDropdownMaxFirstVisible();
    const defaultPreferredRow = Math.floor(visibleItems / 2);
    const requestedPreferredRow = preferredRow ?? defaultPreferredRow;
    const clampedPreferredRow = Math.max(0, Math.min(visibleItems - 1, requestedPreferredRow));
    const preferredFirstVisible = Math.min(Math.max(0, index - clampedPreferredRow), maxFirstVisible);
    const minimumFirstVisible = Math.max(0, index - (visibleItems - 1));
    return Math.max(minimumFirstVisible, Math.min(preferredFirstVisible, maxFirstVisible));
  }

  // --- Light status cache ---
  readonly lastStatusByLight = new Map<string, boolean>();

  // --- Connection health ---
  consecutiveEmptyRenders = 0;
  lastReconnectAt = 0;

  // --- Mutations ---
  applyDropdownView(view: { firstVisible: number; labels: DropdownLabel[] }): void {
    this.dropdownOpen = true;
    this.dropdownFirstVisible = view.firstVisible;
    this.dropdownVisibleLabels = view.labels;
  }

  resetDropdown(): void {
    this.dropdownOpen = false;
    this.dropdownFirstVisible = 0;
    this.dropdownVisibleLabels = [];
    this.dropdownSelectedHeader = null;
  }

  resetAll(): void {
    this.resetDropdown();
    this.lastStatusByLight.clear();
    this.consecutiveEmptyRenders = 0;
  }
}
