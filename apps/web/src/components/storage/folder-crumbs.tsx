import { useNavigate } from "@tanstack/react-router";
import { IconEllipsis, IconFolder } from "@/components/icons/central";
import { Breadcrumbs, BreadcrumbsItem } from "@/components/ui/breadcrumbs";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";

export function FolderCrumbs(props: {
  top: { name: string; href: string };
  /** The folders below the top, down to this one. */
  path: { id: string; name: string }[];
  href: (folderId: string) => string;
}) {
  const navigate = useNavigate();
  const folded = props.path.length > 2 ? props.path.slice(0, -2) : [];
  const shown = props.path.slice(folded.length);
  return (
    <Breadcrumbs aria-label="Folder" size="lg">
      <BreadcrumbsItem className="shrink-0" href={props.top.href}>
        {props.top.name}
      </BreadcrumbsItem>
      {folded.length > 0 && (
        <BreadcrumbsItem className="shrink-0">
          <MenuTrigger>
            <Button intent="plain" size="sq-xs" aria-label="More folders">
              <IconEllipsis />
            </Button>
            <Menu placement="bottom start">
              {folded.map((entry) => (
                <MenuItem
                  key={entry.id}
                  id={entry.id}
                  textValue={entry.name}
                  onAction={() => void navigate({ href: props.href(entry.id) })}
                >
                  <IconFolder data-slot="icon" />
                  <MenuLabel>{entry.name}</MenuLabel>
                </MenuItem>
              ))}
            </Menu>
          </MenuTrigger>
        </BreadcrumbsItem>
      )}
      {shown.map((entry) => (
        <BreadcrumbsItem key={entry.id} href={props.href(entry.id)}>
          {entry.name}
        </BreadcrumbsItem>
      ))}
    </Breadcrumbs>
  );
}
