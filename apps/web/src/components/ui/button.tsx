import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

/**
 * Buttons in the sample's language: ink primary, outlined secondary, quiet ghost and icon buttons.
 * Radii, fonts and colors come from the active theme tokens.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-[7px] whitespace-nowrap rounded-sym font-medium select-none disabled:cursor-default disabled:opacity-60 aria-disabled:cursor-default aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sym-focus [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "border-0 bg-sym-ink text-sym-on-ink",
        secondary:
          "border border-sym-line-strong bg-sym-surface text-sym-text hover:bg-sym-hover disabled:hover:bg-sym-surface",
        ghost: "border-0 bg-transparent text-sym-muted hover:bg-sym-hover hover:text-sym-text",
        danger: "border border-sym-line-strong bg-sym-surface text-sym-danger hover:bg-sym-hover",
        link: "h-auto border-0 bg-transparent p-0 text-sym-link underline-offset-2 hover:underline",
      },
      size: {
        sm: "h-7 px-2.5 text-[13px]",
        md: "h-8 px-3 text-[13.5px]",
        lg: "h-[34px] px-3 text-sm",
        icon: "size-7 p-0",
        "icon-lg": "size-[30px] p-0",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "md",
    },
  },
);

type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, type ButtonProps, buttonVariants };
