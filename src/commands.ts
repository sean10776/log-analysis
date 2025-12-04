import * as vscode from "vscode";
import { deleteProjectFile, readSettings, saveSettings } from "./settings";
import {
    State,
    Project,
    Group,
    createProject,
    LARGE_FILE_CONFIG,
    createGroup,
} from "./utils";
import { Filter, EditorInfo } from "./filter";
import { FocusProvider } from "./focusProvider";

// ============================================================================
// Update Interfaces - Each function has single responsibility
// ============================================================================

/**
 * Update Project Tree View
 * Responsibility: Refresh the project list tree view display
 * Call when: Project added/deleted/renamed
 */
function updateProjectTreeView(state: State) {
    const projectsArray = Array.from(state.projectsMap.values());
    state.projectTreeViewProvider.update(projectsArray);
}

/**
 * Update Filter/Group Tree View
 * Responsibility: Refresh the filter and group tree view display
 * Call when: Filter/Group added/deleted/renamed/reordered
 */
export function updateFilterTreeView(state: State) {
    const project = state.selectedProject;
    if (!project) {
        return;
    }
    const groups = project.groups.values() || null;
    if (!groups) {
        return;
    }
    state.filterTreeViewProvider.update(Array.from(groups));
}

/**
 * Update Focus Provider
 * Responsibility: Bind FocusProvider to current project
 * Call when: Project switched
 */
function updateFocusProvider(state: State) {
    const project = state.selectedProject;
    if (!project) {
        return;
    }
    state.focusProvider.update(project);
}

/**
 * Apply Filter Highlights to Editors
 * Responsibility: Process all visible editors with all filters
 * Call when: Filter properties changed (visibility/highlight/exclude/regex)
 */
async function applyFilterHighlights(
    state: State,
    editors: readonly EditorInfo[]
): Promise<void> {
    const filters = state.selectedProject?.filters;
    if (!filters || filters.size === 0) {
        return;
    }

    const promises: Promise<void>[] = [];
    editors.forEach((editor) => {
        filters.forEach((filter) => {
            promises.push(filter.processEditor(editor));
        });
    });
    await Promise.all(promises);
}

/**
 * Refresh Focus Mode Editors
 * Responsibility: Regenerate content for all visible focus mode editors
 * Call when: Filter cache updated (after applyFilterHighlights)
 */
function refreshFocusModeEditors(state: State, editors: readonly EditorInfo[]) {
    editors.forEach(({editor, metaData}) => {
        if (metaData.isFocusMode) {
            state.focusProvider.refresh(editor);
        }
    });
}

/**
 * Apply Decorations to Focus Mode Editor
 * Responsibility: Apply filter decorations to focus mode document
 * Call when: Focus mode content has been refreshed
 */
function applyFocusModeDecorations(state: State, focusEditor: vscode.TextEditor): void {
    // 1. Apply focus mode marker (identity decoration)
    FocusProvider.applyFocusModeMarker(focusEditor);

    // 2. Apply filter decorations
    const originalUri = FocusProvider.getOriginalUri(focusEditor.document.uri);
    if (!originalUri) {
        return;
    }

    const filters = state.selectedProject?.filters;
    if (!filters) {
        return;
    } 

    vscode.workspace.openTextDocument(originalUri).then(originalDoc => {
        // Get visible lines in focus document
        const visibleLines = state.focusProvider.getVisibleLines(
            originalUri.toString(), 
            originalDoc
        );

        // Apply each filter's decoration
        filters.forEach(filter => {
            // Only apply decoration if filter is highlighted and not exclude
            if (!filter.decoration || !filter.isHighlighted || filter.isExclude) {
                return;
            }

            const matchedLines = filter.getMatchedLineNumbers(originalUri.toString());
            const focusRanges = buildFocusDecorationRanges(matchedLines, visibleLines);
            
            focusEditor.setDecorations(filter.decoration, focusRanges);
        });
    });
}

/**
 * Build decoration ranges for focus document
 * @param matchedLines - Line numbers in original document
 * @param visibleLines - Sorted line numbers visible in focus document
 */
function buildFocusDecorationRanges(
    matchedLines: number[],
    visibleLines: number[]
): vscode.Range[] {
    const ranges: vscode.Range[] = [];
    
    matchedLines.forEach(originalLineNum => {
        // Find the position of this original line in focus document
        const focusLineIndex = visibleLines.indexOf(originalLineNum);
        if (focusLineIndex !== -1) {
            // Focus document line 0 is empty, so actual line number is index + 1
            const focusLineNum = focusLineIndex + 1;
            ranges.push(
                new vscode.Range(
                    new vscode.Position(focusLineNum, 0),
                    new vscode.Position(focusLineNum, 0)
                )
            );
        }
    });

    return ranges;
}

/**
 * Full Editor Refresh
 * Responsibility: Complete update cycle for all visible editors
 * Call when: Any filter change that affects display
 * - Applies filter highlights
 * - Refreshes focus mode content
 * - Updates filter tree view (to reflect new count values)
 */
export function refreshEditors(state: State) {
    const filters = state.selectedProject?.filters;
    if (!filters || filters.size === 0) {
        return;
    }

    const visibleEditors = vscode.window.visibleTextEditors;
    const activatedEditor = vscode.window.activeTextEditor;
    const editorInfos: EditorInfo[] = visibleEditors.map(editor => ({
        editor,
        uri: editor.document.uri,
        metaData: {
            lineCount: editor.document.lineCount,
            isLargeFile: editor.document.getText().length > LARGE_FILE_CONFIG.SIZE_THRESHOLD,
            isFocusMode: FocusProvider.isFocusUri(editor.document.uri),
            isSelected: activatedEditor ? editor.document.uri.toString() === activatedEditor.document.uri.toString() : false,
        }
    }));

    void applyFilterHighlights(state, editorInfos).then(() => {
        // Refresh focus mode content
        refreshFocusModeEditors(state, editorInfos);
        
        // Apply decorations to focus mode editors after content is updated
        // Use setTimeout to ensure content has been refreshed
        setTimeout(() => {
            editorInfos.forEach(({editor, metaData}) => {
                if (metaData.isFocusMode) {
                    applyFocusModeDecorations(state, editor);
                }
            });
        }, 10);
        
        // Update tree view after cache is updated (count values may have changed)
        updateFilterTreeView(state);
    });
}

//set bool for whether the lines matched the given filter will be kept for focus mode
export function setVisibility(
    isShown: boolean,
    treeItem: vscode.TreeItem,
    state: State
) {
    const id = treeItem.id!;
    
    // Check if it's a group operation
    if (id.startsWith('group-')) {
        const group = state.selectedProject?.groups.get(id);
        if (group) {
            group.isShown = isShown;
            group.filters.forEach((filter) => {
                filter.isShown = isShown;
            });
        }
    } 
    // Check if it's a filter operation
    else if (id.startsWith('filter-')) {
        const filter = state.selectedProject?.filters.get(id);
        if (filter) {
            filter.isShown = isShown;
        }
    }

    // Update: Filter properties changed → refresh editors (tree view auto-updated)
    refreshEditors(state);
}

export function setHighlight(
    isHighlighted: boolean,
    treeItem: vscode.TreeItem,
    state: State
) {
    const id = treeItem.id!;

    // Check if it's a group operation
    if (id.startsWith('group-')) {
        const group = state.selectedProject?.groups.get(id);
        if (group) {
            group.isHighlighted = isHighlighted;
            group.filters.forEach((filter) => {
                filter.isHighlighted = isHighlighted;
            });
        }
    } 
    // Check if it's a filter operation
    else if (id.startsWith('filter-')) {
        const filter = state.selectedProject?.filters.get(id);
        if (filter) {
            filter.isHighlighted = isHighlighted;
        }
    }

    // Update: Filter properties changed → refresh editors (tree view auto-updated)
    refreshEditors(state);
}

export function setExclude(
    isExclude: boolean,
    treeItem: vscode.TreeItem,
    state: State
) {
    const id = treeItem.id!;

    const filter = state.selectedProject?.filters.get(id);
    if (!filter) {
        return;
    }
    filter.isExclude = isExclude;

    // Update: Filter properties changed → refresh editors (tree view auto-updated)
    refreshEditors(state);
}

//turn on focus mode for the active editor. Will create a new tab if not already for the virtual document
export function turnOnFocusMode() {
    let editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    let originalUri = editor.document.uri;
    if (FocusProvider.isFocusUri(originalUri)) {
        //avoid creating nested focus mode documents
        vscode.window.showInformationMessage(
            "You are on focus mode virtual document already!"
        );
        return;
    }

    //set special schema
    let virtualUri = FocusProvider.virtualUri(originalUri);
    vscode.workspace
        .openTextDocument(virtualUri)
        .then((doc) => vscode.window.showTextDocument(doc));
}

/**
 * Filter related commands
 */
export function deleteFilter(treeItem: vscode.TreeItem, state: State) {
    const filter = state.selectedProject?.filters.get(treeItem.id!);
    if (!filter) {
        return;
    }
    state.selectedProject?.filters.delete(treeItem.id!);
    state.selectedProject?.groups.forEach((group) => {
        if (group.filters.has(treeItem.id!)) {
            group.filters.delete(treeItem.id!);
        }
    });
    filter.dispose();
    
    // Update: Filter deleted → refresh editors (tree view auto-updated)
    refreshEditors(state);
    saveSettings(state.globalStorageUri, state.projectsMap, state.selectedProject);
}

export function addFilter(treeItem: vscode.TreeItem, state: State) {
    vscode.window
        .showInputBox({
            prompt: "[FILTER] Type a regex for that filter",
            ignoreFocusOut: false,
        })
        .then((regexStr) => {
            const group = state.selectedProject?.groups.get(treeItem.id!);
            if (!regexStr || !group) {
                return;
            }

            const filter = new Filter(new RegExp(regexStr));
            group!.filters.set(filter.id, filter);
            state.selectedProject?.filters.set(filter.id, filter); // for fast lookup
            
            // Update: Filter added → refresh editors (tree view auto-updated)
            refreshEditors(state);
            saveSettings(state.globalStorageUri, state.projectsMap, state.selectedProject);
        });
}

export function editFilter(treeItem: vscode.TreeItem, state: State) {
    const filter = state.selectedProject?.filters.get(treeItem.id!);
    if (!filter) {
        return;
    }

    vscode.window
        .showInputBox({
            prompt: "[FILTER] Type a new regex",
            ignoreFocusOut: false,
            value: filter.regex.source, // Pre-fill with the current regex
        })
        .then((regexStr) => {
            if ( regexStr === undefined || regexStr === filter.regex.source ) {
                return;
            }

            try {
                // Update the filter's regex using new method that handles cache invalidation
                filter.setRegex(new RegExp(regexStr));
                
                // Update: Filter regex changed → refresh editors (tree view auto-updated)
                refreshEditors(state);
                saveSettings(state.globalStorageUri, state.projectsMap, state.selectedProject);
            } catch (e) {
                // Show an error message if the new regex is invalid
                vscode.window.showErrorMessage(`Invalid Regex: ${e}`);
            }
        });
}

/**
 * Group related commands
 */
export function addGroup(state: State) {
    vscode.window
        .showInputBox({
            prompt: "[GROUP] Type a new group name",
            ignoreFocusOut: false,
        })
        .then((name) => {
            if (name === undefined) {
                return;
            }

            const group: Group = createGroup(name);
            state.selectedProject?.groups.set(group.id, group);

            // Update: Group added → update tree only (no filter change)
            updateFilterTreeView(state);
            saveSettings(state.globalStorageUri, state.projectsMap, state.selectedProject);
        });
}

export function editGroup(treeItem: vscode.TreeItem, state: State) {
    const group = state.selectedProject?.groups.get(treeItem.id!);
    if (!group) {
        return;
    }
    vscode.window
        .showInputBox({
            prompt: "[GROUP] Type a new group name",
            value: group.name,
            ignoreFocusOut: false,
        })
        .then((name) => {
            if (name === undefined) {
                return;
            }
            group!.name = name;
            
            // Update: Group renamed → update tree only (no filter change)
            updateFilterTreeView(state);
            saveSettings(state.globalStorageUri, state.projectsMap, state.selectedProject);
        });
}

export function deleteGroup(treeItem: vscode.TreeItem, state: State) {
    const group = state.selectedProject?.groups.get(treeItem.id!);
    if (!group) {
        return;
    }

    group.filters.forEach((filter) => {
        state.selectedProject?.filters.delete(filter.id);
        filter.dispose();
    });
    state.selectedProject?.groups.delete(treeItem.id!);

    // Update: Group and filters deleted → refresh editors (tree view auto-updated)
    refreshEditors(state);
    saveSettings(state.globalStorageUri, state.projectsMap, state.selectedProject);
}

/**
 * Project related commands
 */

function validProjectName(name: string): boolean {
    // project name should also be a valid file name
    const invalidChars = /[<>:"\/\\|?*\x00-\x1F]/g;
    return !invalidChars.test(name);
}

function _addProject(state: State, name: string) {
    if (!validProjectName(name)) {
        vscode.window.showErrorMessage("Invalid project name");
        return null;
    }
    if (state.projectsMap.has(name)) {
        vscode.window.showErrorMessage("Project name already exists");
        return null;
    }

    const project: Project = createProject(name);
    state.projectsMap.set(project.name, project);
    return project;
}

export function addProject(state: State) {
    vscode.window
        .showInputBox({
            prompt: "[PROJECT] Type a new project name",
            ignoreFocusOut: false,
        })
        .then((name) => {
            if (name === undefined || !_addProject(state, name)) {
                return;
            }

            updateProjectTreeView(state);
            saveSettings(state.globalStorageUri, state.projectsMap, state.selectedProject);
        });
}

export function editProject(
    treeItem: vscode.TreeItem,
    state: State,
) {
    let project = state.projectsMap.get(treeItem.id!);
    if (project === undefined) {
        return;
    }

    vscode.window
        .showInputBox({
            prompt: "[PROJECT] Type a new name",
            value: project.name,
            ignoreFocusOut: false,
        })
        .then((name) => {
            if (name === undefined) {
                return;
            }
            const newProject = _addProject(state, name);
            if (newProject === null) {
                return;
            }
            state.projectsMap.delete(project!.name);
            deleteProjectFile(state.globalStorageUri, project!);
            state.projectsMap.set(name, newProject);

            // copy elements to the new project
            newProject.groups = project!.groups;
            newProject.filters = project!.filters;
            newProject.selected = project!.selected;

            updateProjectTreeView(state);
            saveSettings(state.globalStorageUri, state.projectsMap, state.selectedProject);
        });
}

export function deleteProject(treeItem: vscode.TreeItem, state: State) {
    const project = state.projectsMap.get(treeItem.id!);
    if (project === undefined) {
        return;
    }

    project.filters.forEach((filter) => {
        filter.dispose();
    });

    let selectChanged = false;
    if (project === state.selectedProject) {
        state.selectedProject = state.projectsMap.values().next().value || null;
        selectChanged = true;
    }

    state.projectsMap.delete(treeItem.id!);
    deleteProjectFile(state.globalStorageUri, project);
    
    // Update: Project deleted
    if (selectChanged) {
        // Current project deleted → update all (refreshEditors will update filter tree)
        updateProjectTreeView(state);
        updateFocusProvider(state);
        refreshEditors(state);
    } else {
        // Other project deleted → update project tree only
        updateProjectTreeView(state);
    }
    
    saveSettings(state.globalStorageUri, state.projectsMap, state.selectedProject);
}

export function selectProject(
    treeItem: vscode.TreeItem,
    state: State
): boolean {
    const currentProject = state.selectedProject;

    if (currentProject && currentProject.id === treeItem.id) {
        vscode.window.showInformationMessage("This project is already selected");
        return true;
    }

    state.selectedProject = state.projectsMap.get(treeItem.id! ) || null;
    if (!state.selectedProject) {
        vscode.window.showErrorMessage("Selected project not found");
        state.selectedProject = currentProject;
        return false;
    }

    state.selectedProject.selected = true;

    if (currentProject) {
        currentProject.selected = false;
        currentProject.filters.forEach((filter) => {
            filter.dispose();
        });
    }

    // Update: Project switched → update all (refreshEditors will update filter tree)
    updateProjectTreeView(state);
    updateFocusProvider(state);
    refreshEditors(state);
    saveSettings(state.globalStorageUri, state.projectsMap, state.selectedProject);
    return true;
}

function createDefaultProject(state: State) {
    const default_project: Project = createProject("NONAME");
    state.projectsMap.set(default_project.name, default_project);
    state.selectedProject = default_project;
}

export function refreshSettings(state: State) {
    const { projects, selectedProject } = readSettings(state.globalStorageUri);
    state.projectsMap = projects;
    if (state.selectedProject && selectedProject !== state.selectedProject) {
        state.selectedProject.filters.forEach((filter) => {
            filter.dispose();
        });
    }
    state.selectedProject = selectedProject;

    // Add a project named "NONAMED" in the following cases:
    // - A default project is generated for users who do not use the project feature.
    // - If multiple projects are available but none is selected, an empty project is created and selected.
    if (state.projectsMap.size === 0) {
        createDefaultProject(state);
        saveSettings(state.globalStorageUri, state.projectsMap, state.selectedProject);
    }

    // Update: Settings reloaded → update all (refreshEditors will update filter tree)
    updateProjectTreeView(state);
    updateFocusProvider(state);
    refreshEditors(state);
}

export async function exportProject(state: State, projectItem: any) {
    const projectId = projectItem?.id;
    if (!projectId) {
        vscode.window.showErrorMessage("No project selected for export.");
        return;
    }

    const project = state.projectsMap.get(projectId);
    if (!project) {
        vscode.window.showErrorMessage("Project not found.");
        return;
    }

    const defaultUri = vscode.Uri.file(`${project.name}.json`);
    const uri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: {
            'JSON Files': ['json'],
            'All Files': ['*']
        },
        title: `Export Project: ${project.name}`
    });

    if (!uri) {
        return; // User cancelled
    }

    try {
        // Get the project file path from internal storage
        const { getProjectFilePath, projectFileName } = require('./settings');
        const projectFile = getProjectFilePath(state.globalStorageUri, projectFileName(project));
        
        // Read the existing project file and copy to export location
        const content = await vscode.workspace.fs.readFile(vscode.Uri.file(projectFile));
        await vscode.workspace.fs.writeFile(uri, content);
        
        vscode.window.showInformationMessage(`Project "${project.name}" exported successfully.`);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to export project: ${error}`);
    }
}

export async function importProject(state: State) {
    const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: {
            'JSON Files': ['json'],
            'All Files': ['*']
        },
        title: 'Import Project'
    });

    if (!uris || uris.length === 0) {
        return; // User cancelled
    }

    try {
        // Read the file content
        const content = await vscode.workspace.fs.readFile(uris[0]);
        const data = JSON.parse(content.toString());

        // Validate data structure
        if (!data.name || !Array.isArray(data.groups)) {
            vscode.window.showErrorMessage("Invalid project file format.");
            return;
        }

        // Check if project with same name already exists
        let projectName = data.name;
        let counter = 1;
        while (state.projectsMap.has(projectName)) {
            projectName = `${data.name}_${counter}`;
            counter++;
        }

        // Save to temporary file in projects directory and use loadProject
        const { getProjectFilePath, loadProject } = require('./settings');
        const tempFileName = `${projectName}.json`;
        const tempFilePath = getProjectFilePath(state.globalStorageUri, tempFileName);
        
        // Write the content with potentially renamed project
        const updatedData = { ...data, name: projectName };
        await vscode.workspace.fs.writeFile(
            vscode.Uri.file(tempFilePath),
            Buffer.from(JSON.stringify(updatedData, null, 4), 'utf8')
        );
        
        // Load using existing loadProject function
        const newProject = loadProject(state.globalStorageUri, tempFileName);
        
        if (!newProject) {
            vscode.window.showErrorMessage("Failed to load imported project.");
            return;
        }

        // Add to projects map
        state.projectsMap.set(newProject.name, newProject);
        
        // Save settings
        saveSettings(state.globalStorageUri, state.projectsMap, state.selectedProject);
        
        // Refresh UI
        updateProjectTreeView(state);
        
        vscode.window.showInformationMessage(`Project "${projectName}" imported successfully.`);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to import project: ${error}`);
    }
}
