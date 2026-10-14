#!/usr/bin/env python3
"""A small Qt 5 app for northbridge's integration tests: Qt exposes AT-SPI itself, not via ATK."""

import sys

from PyQt5.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QFormLayout, QLabel, QLineEdit, QPushButton, QSpinBox,
    QVBoxLayout, QWidget,
)


def main():
    app = QApplication(sys.argv)
    window = QWidget()
    window.setWindowTitle("Qt Fixture")
    layout = QVBoxLayout(window)
    form = QFormLayout()
    name = QLineEdit()
    name.setObjectName("name-field")
    form.addRow("&Name", name)
    color = QComboBox()
    color.addItems(["Red", "Green", "Blue"])
    form.addRow("&Color", color)
    count = QSpinBox()
    count.setRange(0, 10)
    form.addRow("C&ount", count)
    layout.addLayout(form)
    agree = QCheckBox("I agree")
    layout.addWidget(agree)
    status = QLabel("Ready")
    status.setObjectName("status")
    submit = QPushButton("Submit")

    def on_submit():
        status.setText(
            f"Submitted: name={name.text()}; color={color.currentText()}; count={count.value()}; "
            f"agree={'yes' if agree.isChecked() else 'no'}"
        )

    submit.clicked.connect(on_submit)
    layout.addWidget(submit)
    layout.addWidget(status)
    window.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()
