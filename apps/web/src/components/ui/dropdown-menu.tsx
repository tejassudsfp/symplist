"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "cn";
import type { ComponentProps } from "react";
import { ACTION_LAYER_ATTRIBUTE } from "@/actions/focus";

/*
 * Menus on Base UI: keyboard opening from the trigger, arrow navigation, typeahead, Escape and
 * click-outside dismissal, and focus returned to the trigger (profile_menu.md). The popup marks itself
 * as a menu layer so shortcuts beneath it stay inactive while it is open (§10.2).
 */

function DropdownMenu(props: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          {...{ [ACTION_LAYER_ATTRIBUTE]: "menu" }}
          className={cn("sym-menu", className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      className={cn(
        "px-[9px] pt-1 pb-1.5 font-medium text-[11.5px] text-sym-muted uppercase tracking-[0.03em]",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn("sym-menu-item", className)}
      {...props}
    />
  );
}

/** A menu item that navigates; pass `render={<Link href=… />}` for client-side routes. */
function DropdownMenuLinkItem({ className, ...props }: MenuPrimitive.LinkItem.Props) {
  return (
    <MenuPrimitive.LinkItem
      data-slot="dropdown-menu-link-item"
      className={cn("sym-menu-item", className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("sym-menu-separator", className)}
      {...props}
    />
  );
}

/** A shortcut hint beside an item, with its spoken form for assistive technology. */
function DropdownMenuShortcut({
  className,
  spoken,
  children,
  ...props
}: ComponentProps<"span"> & { spoken?: string }) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn("font-mono text-[11px] text-sym-muted", className)}
      {...props}
    >
      <span aria-hidden={spoken ? true : undefined}>{children}</span>
      {spoken ? <span className="sr-only">{` (shortcut ${spoken})`}</span> : null}
    </span>
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
};
