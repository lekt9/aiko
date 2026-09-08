import { actor, handles } from "tardie"
import { browserTraceComponent, inspectBrowserTraceMethod } from "./src/browser-trace-component"
import { harComponent, inspectWebsiteMethod } from "./src/har-component"
import {
  draftSiteHarnessMethod,
  harnessComponent,
  planSiteActionMethod,
  recordHarnessCompositionMethod,
  resolveSiteActorMethod
} from "./src/harness-component"

export const methods = {
  inspectBrowserTrace: inspectBrowserTraceMethod,
  inspectWebsite: inspectWebsiteMethod,
  planSiteAction: planSiteActionMethod,
  draftSiteHarness: draftSiteHarnessMethod,
  recordHarnessComposition: recordHarnessCompositionMethod,
  resolveSiteActor: resolveSiteActorMethod
}

export default actor({
  name: "har-website-inspector",
  methods,
  components: [
    handles(inspectWebsiteMethod, harComponent),
    handles(
      planSiteActionMethod,
      handles(
        draftSiteHarnessMethod,
        handles(recordHarnessCompositionMethod, handles(resolveSiteActorMethod, harnessComponent))
      )
    ),
    handles(inspectBrowserTraceMethod, browserTraceComponent)
  ]
})
