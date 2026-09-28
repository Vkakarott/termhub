import { useWindowDimensions } from 'react-native';
import { isWide } from './layout';

/** Whether the app's window is wide enough for the split layout. Follows the window, not the
 * device: rotation, Split View and Slide Over resizes all re-render through it. */
export function useWideLayout(): boolean {
  return isWide(useWindowDimensions().width);
}
