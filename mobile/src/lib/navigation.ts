import { createNavigationContainerRef } from '@react-navigation/native';

/** Root-level navigation ref: lets deep screens (e.g. Settings → Cost
 *  dashboard) navigate across navigator boundaries — the Settings tab lives
 *  in the Tab navigator while CostDashboard is registered in the HomeStack,
 *  and the tab-level navigate can't see it. The container-level ref resolves
 *  through child navigators. */
export const navigationRef = createNavigationContainerRef();
