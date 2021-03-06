import { getColors, getUpdateTriggers, hexToRgb, validateParameters } from './utils';

export function colorBinsStyle(
  featureProperty: string,
  {
    bins = defaultOptions.bins,
    colors = defaultOptions.colors,
    nullColor = defaultOptions.nullColor,
    othersColor = defaultOptions.othersColor
  }: ColorBinsStyleOptions = defaultOptions
) {
  validateBinParameters(featureProperty, bins, colors);

  // Number.MIN_SAFE_INTEGER is here to make closed intervals,
  // that way last range comparison will never be true
  const ranges = [...bins, Number.MIN_SAFE_INTEGER];

  const {
    rgbaColors,
    othersColor: rgbaOthersColor = hexToRgb(othersColor)
  } = getColors(colors, bins.length - 1);

  const rgbaNullColor = hexToRgb(nullColor);

  const getFillColor = (feature: Record<string, any>) => {
    const featureValue: number = feature.properties[featureProperty];

    if (!featureValue) {
      return rgbaNullColor;
    }

    // If we want to add various comparisons (<, >, <=, <=) like in TurboCARTO
    // we can change comparison within the arrow function to a comparison fn
    const rangeComparison = (definedValue: number, currentIndex: number, valuesArray: number[]) =>
      (featureValue >= definedValue) && (featureValue < valuesArray[currentIndex + 1]);

    const featureValueIndex = ranges.findIndex(rangeComparison);
    return rgbaColors[featureValueIndex] || rgbaOthersColor;
  };

  return {
    getFillColor,
    updateTriggers: getUpdateTriggers({ getFillColor })
  };
}

function validateBinParameters(featureProperty: string, values: number[] | string[], colors: string[] | string) {
  const comparison = () => values.length !== (colors.length - 1);
  return validateParameters(featureProperty, colors, comparison);
}

interface ColorBinsStyleOptions {
  bins: number[];
  colors: string[] | string;
  nullColor: string;
  othersColor: string;
}

const defaultOptions = {
  bins: [],
  colors: 'purpor',
  nullColor: '#00000000',
  othersColor: '#00000000'
};
