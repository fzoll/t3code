import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  deriveProjectGroupingOverrideKey,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import type {
  ContextMenuItem,
  EnvironmentId,
  ModelSelection,
  ProjectIconOverride,
  ProviderDriverKind,
  ProviderInstanceEnvironmentVariable,
  SidebarProjectGroupingMode,
  T3ProjectFileScript,
  ThreadEnvMode,
} from "@t3tools/contracts";
import { resolveEnvModeLabel } from "../BranchToolbar.logic";
import { createModelSelection } from "@t3tools/shared/model";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { Trash2Icon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EnvironmentVariableEditor } from "../EnvironmentVariableEditor";
import { Switch } from "../ui/switch";

import { useComposerDraftStore } from "../../composerDraftStore";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { readLocalApi } from "../../localApi";
import {
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  canPickExternalProjectFavicon,
  ProjectFaviconPickerDialog,
} from "./ProjectFaviconPickerDialog";
import { ProjectActionsSettings } from "./ProjectActionsSettings";
import { projectGroupTitleNeedsUpdate } from "./ProjectSettingsPanel.logic";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

const ProjectIconPickerDialog = lazy(() =>
  import("./ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

function memberKey(member: { environmentId: string; id: string }): string {
  return `${member.environmentId}:${member.id}`;
}

export type ProjectSettingsCategory = "general" | "integrations" | "source-control";

export function ProjectSettingsPanel({
  projectKey,
  environmentId = null,
  checkoutKey = null,
}: {
  projectKey: string;
  environmentId?: EnvironmentId | null;
  checkoutKey?: string | null;
}) {
  const groups = useSettingsProjectGroups();
  const navigate = useNavigate({ from: "/settings" });
  const pathname = useLocation({ select: (location) => location.pathname });

  const selected = groups.find((group) => group.projectKey === projectKey) ?? null;
  const members = useMemo(
    () =>
      selected?.memberProjects.filter(
        (member) =>
          (environmentId === null || member.environmentId === environmentId) &&
          (checkoutKey === null || member.physicalProjectKey === checkoutKey),
      ) ?? [],
    [selected, environmentId, checkoutKey],
  );

  // Remember the members of the last rendered group so a grouping-rule change
  // (which changes the group key) can follow the project to its new group.
  const lastSelectionRef = useRef<{
    key: string;
    environmentId: EnvironmentId | null;
    checkoutKey: string | null;
    memberKeys: string[];
  } | null>(null);
  useEffect(() => {
    if (!selected || members.length === 0) return;
    lastSelectionRef.current = {
      key: selected.projectKey,
      environmentId,
      checkoutKey,
      memberKeys: members.map((member) => member.physicalProjectKey),
    };
  }, [selected, members, environmentId, checkoutKey]);

  // A grouping-rule change replaces the group key mid-visit; follow the
  // project to its new key instead of parking on the not-found state.
  useEffect(() => {
    if (members.length > 0) return;
    const last = lastSelectionRef.current;
    if (
      last?.key !== projectKey ||
      last.environmentId !== environmentId ||
      last.checkoutKey !== checkoutKey
    )
      return;
    const successor = groups.find((group) =>
      group.memberProjects.some((member) => last.memberKeys.includes(member.physicalProjectKey)),
    );
    if (successor) {
      void navigate({
        to: pathname,
        search: () => ({
          project: successor.projectKey,
          machine: environmentId ?? undefined,
          checkout: checkoutKey ?? undefined,
        }),
        replace: true,
        hashScrollIntoView: false,
      });
    }
  }, [groups, navigate, pathname, projectKey, members.length, environmentId, checkoutKey]);

  if (!selected) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        {groups.length === 0
          ? "Add a project from the sidebar to configure it here."
          : "This project is no longer available."}
      </div>
    );
  }
  if (members.length === 0)
    return (
      <p className="p-8 text-sm text-muted-foreground">
        This checkout is no longer available in the selected project and environment.
      </p>
    );
  const scopedGroup = {
    ...selected,
    memberProjects: members,
    environmentId: members[0]!.environmentId,
    id: members[0]!.id,
  };
  return (
    <ProjectDetail
      key={`${selected.projectKey}:${environmentId ?? "all"}:${checkoutKey ?? "all"}`}
      group={scopedGroup}
      hasOtherMembers={members.length < selected.memberProjects.length}
    />
  );
}

function ProjectDetail({
  group,
  hasOtherMembers,
}: {
  group: SidebarProjectSnapshot;
  hasOtherMembers: boolean;
}) {
  const navigate = useNavigate({ from: "/settings" });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );
  const representative =
    group.memberProjects.find(
      (member) => environmentById.get(member.environmentId)?.serverConfig != null,
    ) ?? group.memberProjects[0]!;
  const threads = useThreadShells();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const projectNameEditedRef = useRef(false);

  const faviconPath = representative.faviconPath ?? null;
  const projectIcon = representative.projectIcon ?? null;
  const pickProjectFavicon =
    typeof window !== "undefined" &&
    group.memberProjects.every(
      (member) =>
        member.environmentId === primaryEnvironmentId &&
        canPickExternalProjectFavicon(member.workspaceRoot, navigator.platform),
    )
      ? window.desktopBridge?.pickProjectFavicon
      : undefined;

  const reportFailure = useCallback((title: string, result: AtomCommandResult<void, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);

  // Group-shared fields live on each physical project record, so a
  // group-level edit fans out to every member.
  const updateAllMembers = useCallback(
    async (
      input: Partial<{
        title: string;
        faviconPath: string | null;
        environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
        isAuto: boolean;
        group: string | null;
        projectIcon: ProjectIconOverride | null;
      }>,
      failureTitle: string,
    ): Promise<AtomCommandResult<void, unknown>> => {
      const unavailable = group.memberProjects.find((member) => {
        const environment = environmentById.get(member.environmentId);
        return environment?.connection.phase !== "connected" || !environment.serverConfig;
      });
      if (unavailable) {
        const error = new Error(
          `Connect ${unavailable.environmentLabel ?? "the selected environment"} and try again.`,
        );
        const result: AtomCommandResult<void, unknown> = AsyncResult.failure(Cause.fail(error));
        reportFailure(failureTitle, result);
        return result;
      }
      for (const member of group.memberProjects) {
        const result = mapAtomCommandResult(
          await updateProject({
            environmentId: member.environmentId,
            input: { projectId: member.id, ...input },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          // A partial fan-out is possible: earlier members already took the
          // write. Name the environment so the user knows where it stopped.
          reportFailure(
            group.memberProjects.length > 1
              ? `${failureTitle} on ${member.environmentLabel ?? "the current environment"}`
              : failureTitle,
            result,
          );
          return result;
        }
      }
      return AsyncResult.success(undefined);
    },
    [environmentById, group.memberProjects, reportFailure, updateProject],
  );

  const renameGroup = useCallback(
    async (nextTitle: string, wasEdited: boolean) => {
      const title = nextTitle.trim();
      if (!title) {
        toastManager.add({ type: "warning", title: "Project title cannot be empty" });
        return;
      }
      if (
        !projectGroupTitleNeedsUpdate(
          group.memberProjects.map((member) => member.title),
          title,
          wasEdited,
        )
      ) {
        return;
      }
      await updateAllMembers({ title }, "Failed to rename project");
    },
    [group.memberProjects, updateAllMembers],
  );

  // ----- project icon -----
  const [faviconPickerOpen, setFaviconPickerOpen] = useState(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [isSavingFavicon, setIsSavingFavicon] = useState(false);
  const savingFaviconRef = useRef(false);
  const setProjectIcon = useCallback(
    async (input: { faviconPath: string | null; projectIcon: ProjectIconOverride | null }) => {
      if (savingFaviconRef.current) return;
      savingFaviconRef.current = true;
      setIsSavingFavicon(true);
      try {
        await updateAllMembers(input, "Failed to update project icon");
      } finally {
        savingFaviconRef.current = false;
        setIsSavingFavicon(false);
      }
    },
    [updateAllMembers],
  );

  // ----- fork fields: environment variables, automation, sidebar group -----
  // All three are group-shared: every checkout of the same repository runs
  // under the same GitHub account, automation flag, and sidebar category.
  const projectEnvironmentVariables = representative.environment ?? [];
  const environmentValuesRef = useRef<() => ReadonlyArray<ProviderInstanceEnvironmentVariable>>(
    () => projectEnvironmentVariables,
  );
  const [isSavingEnvironment, setIsSavingEnvironment] = useState(false);
  const savingEnvironmentRef = useRef(false);

  const saveEnvironment = useCallback(async () => {
    if (savingEnvironmentRef.current) return;
    savingEnvironmentRef.current = true;
    setIsSavingEnvironment(true);
    try {
      const result = await updateAllMembers(
        { environment: environmentValuesRef.current() },
        "Failed to save environment variables",
      );
      if (result._tag !== "Failure") {
        toastManager.add({ type: "success", title: "Environment variables saved" });
      }
    } finally {
      savingEnvironmentRef.current = false;
      setIsSavingEnvironment(false);
    }
  }, [updateAllMembers]);

  const setIsAuto = useCallback(
    async (isAuto: boolean) => {
      await updateAllMembers({ isAuto }, "Failed to update automation setting");
    },
    [updateAllMembers],
  );

  const setSidebarGroup = useCallback(
    async (nextGroup: string) => {
      const trimmed = nextGroup.trim();
      const current = representative.group ?? null;
      const next = trimmed.length > 0 ? trimmed : null;
      if (next === current) return;
      await updateAllMembers({ group: next }, "Failed to update project group");
    },
    [representative.group, updateAllMembers],
  );

  // ----- checkout selection and scripts -----
  const [selectedCheckoutKey, setSelectedCheckoutKey] = useState(representative.physicalProjectKey);
  const selectedCheckout =
    group.memberProjects.find((member) => member.physicalProjectKey === selectedCheckoutKey) ??
    representative;
  const selectedServerConfig = useAtomValue(
    serverEnvironment.configValueAtom(selectedCheckout.environmentId),
  );
  const keybindings = selectedServerConfig?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;
  const scripts = selectedCheckout.scripts;
  const [editorRequest, setEditorRequest] = useState<ProjectScriptEditorRequest | null>(null);
  // Script writes replace the whole array, so two overlapping writes computed
  // from the same snapshot would drop each other's changes. One at a time.
  const [isSavingScripts, setIsSavingScripts] = useState(false);
  const savingScriptsRef = useRef(false);
  const t3File = useT3ProjectFileState(
    selectedCheckout.environmentId,
    selectedCheckout.workspaceRoot,
  );
  // What the "Default" option resolves to while no override is set: the
  // repo's t3.json value when present, otherwise the global setting.
  const inheritedEnvMode = t3File.file?.defaultThreadEnvMode ?? settings.defaultThreadEnvMode;
  const inheritedEnvModeSource = t3File.file?.defaultThreadEnvMode != null ? "t3.json" : "global";
  const importableScripts = useMemo(
    () =>
      t3File.scripts.filter(
        (fileScript) =>
          !scripts.some(
            (script) =>
              script.command === fileScript.command ||
              script.name.toLowerCase() === fileScript.name.toLowerCase(),
          ),
      ),
    [scripts, t3File.scripts],
  );

  const persistScripts = useCallback(
    async (
      nextScripts: ReadonlyArray<ReturnType<typeof buildProjectScript>>,
      keybinding: string | null | undefined,
      keybindingCommand: ReturnType<typeof commandForProjectScript>,
    ): Promise<AtomCommandResult<void, unknown>> => {
      if (savingScriptsRef.current) {
        return AsyncResult.failure(
          Cause.fail(new Error("Another script change is still saving. Try again.")),
        );
      }
      savingScriptsRef.current = true;
      setIsSavingScripts(true);
      try {
        // Captured before the write so a cleared or deleted binding can be
        // removed from the keybindings config afterwards.
        const previousKeybinding = keybindingValueForCommand(keybindings, keybindingCommand);
        const updateResult = mapAtomCommandResult(
          await updateProject({
            environmentId: selectedCheckout.environmentId,
            input: { projectId: selectedCheckout.id, scripts: nextScripts },
          }),
          () => undefined,
        );
        if (updateResult._tag === "Failure") {
          reportFailure("Failed to save scripts", updateResult);
          return updateResult;
        }

        const keybindingRule = decodeProjectScriptKeybindingRule({
          keybinding,
          command: keybindingCommand,
        });
        if (!isElectron) return updateResult;
        const environmentIds = [selectedCheckout.environmentId];
        const previousTarget = previousKeybinding
          ? decodeProjectScriptKeybindingRule({
              keybinding: previousKeybinding,
              command: keybindingCommand,
            })
          : null;
        if (keybindingRule) {
          // `replace` swaps the command's previous rule instead of appending a
          // second one that would keep the old shortcut alive.
          const input =
            previousTarget && previousTarget.key !== keybindingRule.key
              ? { ...keybindingRule, replace: previousTarget }
              : keybindingRule;
          for (const environmentId of environmentIds) {
            const result = mapAtomCommandResult(
              await upsertKeybinding({ environmentId, input }),
              () => undefined,
            );
            if (result._tag === "Failure") {
              reportFailure("Failed to save keybinding", result);
              return result;
            }
          }
        } else if (previousTarget) {
          for (const environmentId of environmentIds) {
            const result = mapAtomCommandResult(
              await removeKeybinding({ environmentId, input: previousTarget }),
              () => undefined,
            );
            if (result._tag === "Failure") {
              reportFailure("Failed to remove keybinding", result);
              return result;
            }
          }
        }
        return updateResult;
      } finally {
        savingScriptsRef.current = false;
        setIsSavingScripts(false);
      }
    },
    [
      keybindings,
      removeKeybinding,
      reportFailure,
      selectedCheckout.environmentId,
      selectedCheckout.id,
      updateProject,
      upsertKeybinding,
    ],
  );

  const submitScript = useCallback(
    async (
      scriptId: string | null,
      input: NewProjectScriptInput,
    ): Promise<AtomCommandResult<void, unknown>> => {
      if (scriptId === null) {
        const nextId = nextProjectScriptId(
          input.name,
          scripts.map((script) => script.id),
        );
        const nextScript = buildProjectScript(nextId, input);
        const nextScripts = input.runOnWorktreeCreate
          ? [
              ...scripts.map((script) =>
                script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
              ),
              nextScript,
            ]
          : [...scripts, nextScript];
        return persistScripts(nextScripts, input.keybinding, commandForProjectScript(nextId));
      }

      const updatedScript = buildProjectScript(scriptId, input);
      const nextScripts = scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );
      return persistScripts(nextScripts, input.keybinding, commandForProjectScript(scriptId));
    },
    [persistScripts, scripts],
  );

  const deleteScript = useCallback(
    (scriptId: string) => {
      const nextScripts = scripts.filter((script) => script.id !== scriptId);
      void persistScripts(nextScripts, null, commandForProjectScript(scriptId));
    },
    [persistScripts, scripts],
  );

  const importFileScript = useCallback(
    async (fileScript: T3ProjectFileScript) => {
      const payload: NewProjectScriptInput = {
        name: fileScript.name,
        command: fileScript.command,
        icon: fileScript.icon ?? "play",
        runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
        keybinding: null,
        previewUrl: fileScript.previewUrl ?? null,
        autoOpenPreview: fileScript.previewUrl ? (fileScript.autoOpenPreview ?? false) : false,
      };
      const result = await submitScript(null, payload);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setEditorRequest({
          scriptId: null,
          initial: payload,
          error: error instanceof Error ? error.message : "Failed to import action.",
        });
      }
    },
    [submitScript],
  );

  // ----- checkouts -----
  const updateGroupingPreference = useCallback(
    (member: SidebarProjectGroupMember, selection: SidebarProjectGroupingMode | "inherit") => {
      const overrideKey = deriveProjectGroupingOverrideKey(member);
      const nextOverrides = { ...projectGroupingSettings.sidebarProjectGroupingOverrides };
      if (selection === "inherit") {
        delete nextOverrides[overrideKey];
      } else {
        nextOverrides[overrideKey] = selection;
      }
      updateClientSettings({ sidebarProjectGroupingOverrides: nextOverrides });
    },
    [projectGroupingSettings.sidebarProjectGroupingOverrides, updateClientSettings],
  );
  const hasMultipleCheckouts = group.memberProjects.length > 1;

  const removeMembers = useCallback(
    async (members: ReadonlyArray<SidebarProjectGroupMember>) => {
      const api = readLocalApi();
      if (!api) return;

      const memberKeys = new Set(members.map(memberKey));
      const projectThreads = threads.filter((thread) =>
        memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
      );
      const isWholeGroup = members.length === group.memberProjects.length;
      const targetKind = hasOtherMembers || !isWholeGroup ? "checkout" : "project";
      const singleMember = members.length === 1 ? members[0]! : null;
      const targetLabel = singleMember?.title ?? group.displayName;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            projectThreads.length > 0
              ? `Remove ${targetKind} "${targetLabel}" and delete its ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"}?`
              : `Remove ${targetKind} "${targetLabel}"?`,
            ...(singleMember
              ? [
                  `Path: ${singleMember.workspaceRoot}`,
                  ...(singleMember.environmentLabel
                    ? [`Environment: ${singleMember.environmentLabel}`]
                    : []),
                ]
              : [`This removes ${members.length} grouped project entries.`]),
            ...(projectThreads.length > 0
              ? [
                  "This permanently clears conversation history for those threads and any archived threads.",
                ]
              : ["This permanently clears any archived conversation history."]),
            isWholeGroup && !hasOtherMembers
              ? "This removes only the project entries, not the files on disk."
              : "Other entries in this grouped project are unaffected.",
            "This action cannot be undone.",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;

      const draftStore = useComposerDraftStore.getState();
      for (const member of members) {
        const memberThreads = projectThreads.filter(
          (thread) =>
            thread.environmentId === member.environmentId && thread.projectId === member.id,
        );
        const result = mapAtomCommandResult(
          await deleteProject({
            environmentId: member.environmentId,
            input: {
              projectId: member.id,
              force: true,
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          reportFailure(`Failed to remove "${member.title}"`, result);
          return;
        }
        const projectRef = scopeProjectRef(member.environmentId, member.id);
        releaseProjectDraftUploads(
          projectRef,
          memberThreads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
        );
        const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
        if (projectDraftThread) {
          draftStore.clearDraftThread(projectDraftThread.draftId);
        }
        draftStore.clearProjectDraftThreadId(projectRef);
      }

      if (isWholeGroup && !hasOtherMembers) {
        void navigate({ to: "/", replace: true });
      }
    },
    [
      deleteProject,
      group.displayName,
      group.memberProjects.length,
      hasOtherMembers,
      navigate,
      reportFailure,
      threads,
    ],
  );

  const checkoutChoices = (
    <SettingsSection title="Checkouts">
      {group.memberProjects.map((member) => (
        <SettingsRow
          key={member.physicalProjectKey}
          title={member.environmentLabel ?? "Environment"}
          description={member.workspaceRoot}
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void removeMembers([member])}
              aria-label={`Remove checkout ${member.workspaceRoot}`}
            >
              Remove
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );

  return (
    <>
      <SettingsPageContainer className="gap-6">
        <SettingsSection id="project-overview" title="Project" hideTitle>
          <SettingsRow
            title="Name"
            description="The shared name for this project group in the sidebar and thread lists."
            control={
              <Input
                key={`${group.projectKey}:${group.displayName}`}
                size="sm"
                className="w-full sm:w-64"
                aria-label="Project name"
                defaultValue={group.displayName}
                onChange={() => {
                  projectNameEditedRef.current = true;
                }}
                onBlur={(event) => {
                  const wasEdited = projectNameEditedRef.current;
                  projectNameEditedRef.current = false;
                  void renameGroup(event.currentTarget.value, wasEdited);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            }
          />
          <SettingsRow
            title="Project icon"
            description={
              projectIcon?.kind === "lucide"
                ? `${projectIcon.name} · ${projectIcon.color}`
                : projectIcon?.kind === "emoji"
                  ? projectIcon.emoji
                  : (faviconPath ?? "Automatic")
            }
            resetAction={
              group.memberProjects.some(
                (member) => member.faviconPath != null || member.projectIcon != null,
              ) ? (
                <SettingResetButton
                  label="project icon"
                  disabled={isSavingFavicon}
                  onClick={() => void setProjectIcon({ faviconPath: null, projectIcon: null })}
                />
              ) : null
            }
            control={
              <div className="flex items-center gap-2">
                <ProjectFavicon project={representative} className="size-6" />
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Choose a project icon"
                  disabled={isSavingFavicon}
                  onClick={() => setIconPickerOpen(true)}
                >
                  Choose icon
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Choose a project icon file"
                  disabled={isSavingFavicon}
                  onClick={() => setFaviconPickerOpen(true)}
                >
                  Choose file
                </Button>
              </div>
            }
          />
          <SettingsRow
            title="Sidebar group"
            description="Free-text category for this project. Projects sharing a group name are grouped together in the sidebar; use / for nesting, e.g. work/clients. Unrelated to the Checkout grouping rule below, which decides how checkouts of one repository merge."
            control={
              <Input
                key={`${group.projectKey}:group:${representative.group ?? ""}`}
                className="w-full sm:w-64"
                aria-label="Sidebar group"
                placeholder="e.g. work, personal, automation"
                defaultValue={representative.group ?? ""}
                onBlur={(event) => {
                  void setSidebarGroup(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            }
          />
          <SettingsRow
            title="Automated project"
            description="Threads here never raise unread notifications or the Completed status pill. Use it for cc_runner sessions that run unattended."
            control={
              <Switch
                checked={representative.isAuto ?? false}
                onCheckedChange={(checked) => void setIsAuto(Boolean(checked))}
                aria-label="Automated project"
              />
            }
          />
        </SettingsSection>

        <SettingsSection title="Environment variables">
          <SettingsRow
            title="Injected into provider sessions"
            description="Variables like GH_TOKEN, GIT_AUTHOR_NAME, or GIT_AUTHOR_EMAIL are passed to every agent session started in this project. Set GH_TOKEN and the matching git identity together — a token from one account with another account's email commits under the wrong author."
            control={
              <Button
                size="xs"
                variant="outline"
                type="button"
                disabled={isSavingEnvironment}
                onClick={() => void saveEnvironment()}
              >
                {isSavingEnvironment ? "Saving..." : "Save"}
              </Button>
            }
          >
            <EnvironmentVariableEditor
              key={`${group.projectKey}:environment`}
              environment={projectEnvironmentVariables}
              onChange={() => {}}
              getValuesRef={environmentValuesRef}
            />
          </SettingsRow>
        </SettingsSection>
        <ProjectActionsSettings />
        {hasMultipleCheckouts ? checkoutChoices : null}
        <SettingsSection title="Danger">
          <SettingsRow
            title={
              hasOtherMembers
                ? "Remove checkout"
                : group.memberProjects.length > 1
                  ? "Remove this project everywhere"
                  : "Remove project"
            }
            description={
              hasOtherMembers
                ? "Deletes the selected machine's checkout entries and their threads. Other machines and files on disk are not touched."
                : group.memberProjects.length > 1
                  ? `Deletes all ${group.memberProjects.length} checkout entries and their threads on every machine. Files on disk are not touched.`
                  : "Deletes the project entry and its threads. Files on disk are not touched."
            }
            control={
              <Button
                size="sm"
                variant="destructive-outline"
                onClick={() => void removeMembers(group.memberProjects)}
              >
                <Trash2Icon />
                {hasOtherMembers
                  ? "Remove checkout"
                  : group.memberProjects.length > 1
                    ? "Remove all entries"
                    : "Remove project"}
              </Button>
            }
          />
        </SettingsSection>
      </SettingsPageContainer>

      <ProjectFaviconPickerDialog
        key={`${representative.environmentId}:${representative.workspaceRoot}:${faviconPickerOpen}`}
        cwd={representative.workspaceRoot}
        environmentId={representative.environmentId}
        onOpenChange={setFaviconPickerOpen}
        {...(pickProjectFavicon
          ? { onPickExternal: () => pickProjectFavicon(representative.workspaceRoot) }
          : {})}
        onSelect={(path) => void setProjectIcon({ faviconPath: path, projectIcon: null })}
        open={faviconPickerOpen}
        projectName={group.displayName}
      />
      {iconPickerOpen ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={projectIcon}
            open
            onOpenChange={setIconPickerOpen}
            onSelect={(icon) => void setProjectIcon({ faviconPath: null, projectIcon: icon })}
          />
        </Suspense>
      ) : null}
    </>
  );
}
