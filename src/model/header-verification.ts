import { uiCoordinates, lightSwitchPlcLabels, lightSwitchNames } from '../config';
import { PaintCommand, extractTextLabels } from '../protocol/paint-commands';
import { normalizeVisuText } from './text-utils';
import pino from 'pino';

const logger = pino({ name: 'header-verification' });

export type DropdownSelectionResult = {
  commands: PaintCommand[];
  headerLabel: string | null;
};

export class DropdownHeaderMismatchError extends Error {
  readonly lightId: string;
  readonly index: number;
  readonly expectedPlcLabel: string;
  readonly expectedName: string;
  readonly actualHeaderLabel: string | null;
  readonly mismatchKind: 'missing' | 'mismatch';

  constructor(params: {
    lightId: string;
    index: number;
    expectedPlcLabel: string;
    expectedName: string;
    actualHeaderLabel: string | null;
    mismatchKind: 'missing' | 'mismatch';
  }) {
    const { lightId, index, expectedPlcLabel, expectedName, actualHeaderLabel, mismatchKind } = params;
    const message = mismatchKind === 'missing'
      ? `Header verification failed: header text missing for light=${lightId}, index=${index}, expected="${expectedPlcLabel}" or "${expectedName}"`
      : `Header verification failed: expected="${expectedPlcLabel}" or "${expectedName}", got="${actualHeaderLabel}", light=${lightId}, index=${index}`;
    super(message);
    this.name = 'DropdownHeaderMismatchError';
    this.lightId = lightId;
    this.index = index;
    this.expectedPlcLabel = expectedPlcLabel;
    this.expectedName = expectedName;
    this.actualHeaderLabel = actualHeaderLabel;
    this.mismatchKind = mismatchKind;
  }
}

export function extractDropdownHeaderLabel(commands: PaintCommand[]): string | null {
  const { dropdownList, dropdownArrow } = uiCoordinates.lightSwitches;
  const labels = extractTextLabels(commands);
  const headerLabels = labels.filter(
    (label) =>
      label.bottom < dropdownList.firstItemY &&
      label.top > 50 &&
      label.left < dropdownArrow.x
  );
  if (headerLabels.length === 0) return null;
  return headerLabels[headerLabels.length - 1].text;
}

export function isExpectedDropdownHeader(index: number, headerLabel: string | null): boolean {
  if (headerLabel === null) return false;
  const expectedPlcLabel = lightSwitchPlcLabels[index];
  const expectedName = lightSwitchNames[index];
  const normalizedHeader = normalizeVisuText(headerLabel);
  const matchesPlcLabel = expectedPlcLabel && normalizeVisuText(expectedPlcLabel) === normalizedHeader;
  const matchesName = expectedName && normalizeVisuText(expectedName) === normalizedHeader;
  return !!(matchesPlcLabel || matchesName);
}

export function buildDropdownHeaderError(lightId: string, index: number, headerLabel: string | null): DropdownHeaderMismatchError {
  const expectedPlcLabel = lightSwitchPlcLabels[index];
  const expectedName = lightSwitchNames[index];
  return new DropdownHeaderMismatchError({
    lightId,
    index,
    expectedPlcLabel,
    expectedName,
    actualHeaderLabel: headerLabel,
    mismatchKind: headerLabel === null ? 'missing' : 'mismatch',
  });
}

export function verifyDropdownHeader(commands: PaintCommand[], lightId: string, index: number): void {
  const headerLabel = extractDropdownHeaderLabel(commands);
  if (!isExpectedDropdownHeader(index, headerLabel)) {
    throw buildDropdownHeaderError(lightId, index, headerLabel);
  }
  logger.info({ lightId, index, headerText: headerLabel }, 'Header verification passed');
}
