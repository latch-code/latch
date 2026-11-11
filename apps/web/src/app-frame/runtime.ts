// The plugin page runtime: a separate IIFE that runs only in the opaque page frame (`app-frame/runtime.html`). It
// carries React, the design system's primitives and the bridge; never import it into the main app.
import {
  Badge,
  Button,
  Checkbox,
  Count,
  EmptyState,
  Group,
  Hint,
  InlineNotice,
  Loading,
  ProgressBar,
  Row,
  SegmentedControl,
  StatusPill,
  Switch,
  TextAreaField,
  TextField,
} from '@latch/ui'
import { startRuntime } from '@latch/app-sdk/runtime'

startRuntime({
  Badge,
  Button,
  Checkbox,
  Count,
  EmptyState,
  Group,
  Hint,
  InlineNotice,
  Loading,
  ProgressBar,
  Row,
  SegmentedControl,
  StatusPill,
  Switch,
  TextAreaField,
  TextField,
})
