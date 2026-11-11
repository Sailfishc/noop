// A second entry, for development only: the component showcase (app/ui/showcase.tsx) alone in the window.
// screens.test.tsx opens it; the app itself (App.tsx) never imports it.
import { mount } from "nsh";
import { Showcase } from "./ui/showcase";

mount(Showcase);
