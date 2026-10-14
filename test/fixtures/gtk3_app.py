#!/usr/bin/env python3
"""A small GTK 3 app with one of everything, for northbridge's integration tests.

Every interaction writes a line to the status label, so tests can check what happened
through the accessibility tree alone.
"""

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Atk", "1.0")
from gi.repository import GLib, Gtk  # noqa: E402


def tag(widget, accessible_id):
    """Give a widget a stable accessible id, the desktop equivalent of data-testid."""
    widget.get_accessible().set_accessible_id(accessible_id)
    return widget


class Fixture(Gtk.Window):
    def __init__(self):
        super().__init__(title="Northbridge Fixture")
        self.set_default_size(640, 520)
        self.connect("destroy", Gtk.main_quit)

        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.add(root)

        root.pack_start(self.build_menubar(), False, False, 0)

        self.status = tag(Gtk.Label(label="Ready"), "status")
        self.status.set_xalign(0)

        notebook = Gtk.Notebook()
        notebook.append_page(self.build_form(), Gtk.Label(label="Form"))
        notebook.append_page(self.build_list(), Gtk.Label(label="List"))
        notebook.append_page(self.build_text(), Gtk.Label(label="Notes"))
        root.pack_start(notebook, True, True, 0)
        root.pack_start(self.status, False, False, 6)

    def say(self, text):
        self.status.set_text(text)

    # Menus ------------------------------------------------------------------------------------

    def build_menubar(self):
        menubar = Gtk.MenuBar()
        file_item = Gtk.MenuItem.new_with_mnemonic("_File")
        file_menu = Gtk.Menu()
        for label in ("New", "Open…", "Save"):
            item = Gtk.MenuItem(label=label)
            item.connect("activate", lambda _w, l=label: self.say(f"Menu: {l}"))
            file_menu.append(item)
        file_menu.append(Gtk.SeparatorMenuItem())
        quit_item = Gtk.MenuItem(label="Quit")
        quit_item.connect("activate", lambda _w: Gtk.main_quit())
        file_menu.append(quit_item)
        file_item.set_submenu(file_menu)
        menubar.append(file_item)

        view_item = Gtk.MenuItem.new_with_mnemonic("_View")
        view_menu = Gtk.Menu()
        wrap = Gtk.CheckMenuItem(label="Word Wrap")
        wrap.connect("toggled", lambda w: self.say(f"Word Wrap: {'on' if w.get_active() else 'off'}"))
        view_menu.append(wrap)
        view_item.set_submenu(view_menu)
        menubar.append(view_item)
        return menubar

    # Form tab ---------------------------------------------------------------------------------

    def labelled(self, grid, row, text, widget):
        label = Gtk.Label.new_with_mnemonic(text)
        label.set_xalign(1)
        label.set_mnemonic_widget(widget)
        grid.attach(label, 0, row, 1, 1)
        grid.attach(widget, 1, row, 1, 1)
        return widget

    def build_form(self):
        grid = Gtk.Grid(column_spacing=12, row_spacing=6, margin=12)

        self.name = tag(self.labelled(grid, 0, "_Name", Gtk.Entry()), "name-field")
        self.email = self.labelled(grid, 1, "_Email", Gtk.Entry())
        self.password = self.labelled(grid, 2, "_Password", Gtk.Entry(visibility=False))

        self.subscribe = Gtk.CheckButton(label="Subscribe to newsletter")
        grid.attach(self.subscribe, 1, 3, 1, 1)

        sizes = Gtk.Box(spacing=6)
        self.sizes = []
        group = None
        for size in ("Small", "Medium", "Large"):
            radio = Gtk.RadioButton.new_with_label_from_widget(group, size)
            group = group or radio
            sizes.pack_start(radio, False, False, 0)
            self.sizes.append(radio)
        self.sizes[1].set_active(True)
        grid.attach(sizes, 1, 4, 1, 1)

        self.color = Gtk.ComboBoxText()
        for c in ("Red", "Green", "Blue"):
            self.color.append_text(c)
        self.color.set_active(0)
        self.color.connect("changed", lambda w: self.say(f"Color: {w.get_active_text()}"))
        self.labelled(grid, 5, "_Color", self.color)

        self.quantity = self.labelled(grid, 6, "_Quantity", Gtk.SpinButton.new_with_range(0, 100, 1))
        self.quantity.set_value(1)

        self.volume = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 100, 1)
        self.volume.set_value(50)
        self.labelled(grid, 7, "_Volume", self.volume)

        self.dark = Gtk.Switch()
        self.dark.connect("notify::active", lambda w, _p: self.say(f"Dark mode: {'on' if w.get_active() else 'off'}"))
        self.labelled(grid, 8, "_Dark mode", self.dark)

        buttons = Gtk.Box(spacing=6)
        submit = tag(Gtk.Button(label="Submit"), "submit")
        submit.connect("clicked", self.on_submit)
        reset = Gtk.Button(label="Reset")
        reset.connect("clicked", self.on_reset)
        disabled = Gtk.Button(label="Unavailable")
        disabled.set_sensitive(False)
        dialog = Gtk.Button(label="Delete…")
        dialog.connect("clicked", self.on_delete)
        later = Gtk.Button(label="Load later")
        later.connect("clicked", self.on_load_later)
        for b in (submit, reset, disabled, dialog, later):
            buttons.pack_start(b, False, False, 0)
        grid.attach(buttons, 1, 9, 1, 1)

        self.loaded_box = Gtk.Box()
        grid.attach(self.loaded_box, 1, 10, 1, 1)
        return grid

    def on_submit(self, _button):
        size = next(r.get_label() for r in self.sizes if r.get_active())
        self.say(
            "Submitted: "
            f"name={self.name.get_text()}; email={self.email.get_text()}; "
            f"password={'*' * len(self.password.get_text())}; "
            f"subscribe={'yes' if self.subscribe.get_active() else 'no'}; size={size}; "
            f"color={self.color.get_active_text()}; quantity={int(self.quantity.get_value())}; "
            f"volume={int(self.volume.get_value())}; dark={'on' if self.dark.get_active() else 'off'}"
        )

    def on_reset(self, _button):
        for entry in (self.name, self.email, self.password):
            entry.set_text("")
        self.subscribe.set_active(False)
        self.sizes[1].set_active(True)
        self.color.set_active(0)
        self.quantity.set_value(1)
        self.volume.set_value(50)
        self.say("Reset")

    def on_delete(self, _button):
        dialog = Gtk.MessageDialog(
            transient_for=self,
            modal=True,
            message_type=Gtk.MessageType.QUESTION,
            buttons=Gtk.ButtonsType.NONE,
            text="Delete everything?",
        )
        dialog.set_title("Confirm")
        dialog.add_buttons("Cancel", Gtk.ResponseType.CANCEL, "Delete", Gtk.ResponseType.OK)
        response = dialog.run()
        dialog.destroy()
        self.say("Deleted" if response == Gtk.ResponseType.OK else "Kept")

    def on_load_later(self, _button):
        self.say("Loading…")

        def done():
            self.loaded_box.pack_start(Gtk.Label(label="Loaded 3 items"), False, False, 0)
            self.loaded_box.show_all()
            self.say("Loaded")
            return False

        GLib.timeout_add(1200, done)

    # List tab ---------------------------------------------------------------------------------

    def build_list(self):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, margin=12)
        self.fruits = Gtk.ListStore(str, int)
        for name, count in (("Apples", 3), ("Bananas", 12), ("Cherries", 40), ("Dates", 7)):
            self.fruits.append([name, count])
        view = Gtk.TreeView(model=self.fruits)
        view.append_column(Gtk.TreeViewColumn("Fruit", Gtk.CellRendererText(), text=0))
        view.append_column(Gtk.TreeViewColumn("Count", Gtk.CellRendererText(), text=1))
        view.get_selection().connect("changed", self.on_fruit_selected)
        view.connect("row-activated", lambda _v, path, _c: self.say(f"Opened: {self.fruits[path][0]}"))
        tag(view, "fruits")
        box.pack_start(view, True, True, 0)

        listbox = Gtk.ListBox()
        for city in ("Lisbon", "Oslo", "Kyoto"):
            listbox.add(Gtk.Label(label=city, xalign=0))
        listbox.connect("row-selected", lambda _l, row: row and self.say(f"City: {row.get_child().get_text()}"))
        box.pack_start(listbox, False, False, 0)
        return box

    def on_fruit_selected(self, selection):
        model, it = selection.get_selected()
        if it is not None:
            self.say(f"Selected: {model[it][0]}")

    # Notes tab --------------------------------------------------------------------------------

    def build_text(self):
        scroller = Gtk.ScrolledWindow(margin=12)
        self.notes = tag(Gtk.TextView(), "notes")
        self.notes.get_buffer().set_text("First line\nSecond line")
        scroller.add(self.notes)
        return scroller


if __name__ == "__main__":
    window = Fixture()
    window.show_all()
    Gtk.main()
